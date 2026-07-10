const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const questions = require("./questions.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
});

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString("hex");

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/player.html");
});

// ---- Game state (single room, in-memory) ----
const state = {
  phase: "lobby", // lobby | question | reveal | ended
  qIndex: -1,
  players: new Map(), // socketId -> { name, score, answered, answerIndex, answerTime }
  questionStartAt: null,
  timer: null,
};

function publicPlayerList() {
  return Array.from(state.players.values()).map((p) => ({
    name: p.name,
    connected: true,
  }));
}

function topThree() {
  return Array.from(state.players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((p) => ({ name: p.name, score: p.score }));
}

function broadcastLobby() {
  io.to("host").emit("host:lobby", {
    count: state.players.size,
    names: publicPlayerList().map((p) => p.name),
  });
}

function currentQuestion() {
  return questions[state.qIndex];
}

function startQuestion(index) {
  if (index >= questions.length) {
    endGame();
    return;
  }
  state.qIndex = index;
  state.phase = "question";
  state.questionStartAt = Date.now();
  for (const p of state.players.values()) {
    p.answered = false;
    p.answerIndex = null;
    p.answerTime = null;
  }

  const q = currentQuestion();
  io.to("players").emit("question", {
    index: state.qIndex,
    total: questions.length,
    question: q.question,
    choices: q.choices,
    timeLimit: q.timeLimit,
  });
  io.to("host").emit("host:question", {
    index: state.qIndex,
    total: questions.length,
    question: q.question,
    choices: q.choices,
    correctIndex: q.correctIndex,
    timeLimit: q.timeLimit,
    answeredCount: 0,
    totalPlayers: state.players.size,
  });

  clearTimeout(state.timer);
  state.timer = setTimeout(() => revealAnswer(), q.timeLimit * 1000 + 300);
}

function maybeEarlyReveal() {
  if (state.phase !== "question") return;
  const total = state.players.size;
  if (total === 0) return;
  const answered = Array.from(state.players.values()).filter((p) => p.answered).length;
  if (answered >= total) {
    clearTimeout(state.timer);
    revealAnswer();
  }
}

function revealAnswer() {
  if (state.phase !== "question") return;
  state.phase = "reveal";
  const q = currentQuestion();

  const distribution = [0, 0, 0, 0];
  for (const p of state.players.values()) {
    if (p.answerIndex !== null && p.answerIndex !== undefined) {
      distribution[p.answerIndex] = (distribution[p.answerIndex] || 0) + 1;
    }
  }

  for (const [id, p] of state.players.entries()) {
    const correct = p.answerIndex === q.correctIndex;
    io.to(id).emit("reveal", {
      correct,
      correctIndex: q.correctIndex,
      yourAnswer: p.answerIndex,
      scoreGained: p.lastGain || 0,
      totalScore: p.score,
    });
  }

  io.to("host").emit("host:reveal", {
    correctIndex: q.correctIndex,
    distribution,
    top3: topThree(),
    isLast: state.qIndex >= questions.length - 1,
  });
}

function endGame() {
  state.phase = "ended";
  io.to("players").emit("gameOver");
  io.to("host").emit("host:gameOver", { top3: topThree() });
}

function resetGame() {
  clearTimeout(state.timer);
  state.phase = "lobby";
  state.qIndex = -1;
  for (const p of state.players.values()) {
    p.score = 0;
    p.answered = false;
    p.answerIndex = null;
    p.answerTime = null;
  }
  io.to("players").emit("resetToLobby");
  broadcastLobby();
}

io.on("connection", (socket) => {
  socket.on("join", ({ name }) => {
    const cleanName = String(name || "ผู้เล่น").trim().slice(0, 24) || "ผู้เล่น";
    state.players.set(socket.id, {
      name: cleanName,
      score: 0,
      answered: false,
      answerIndex: null,
      answerTime: null,
      lastGain: 0,
    });
    socket.join("players");
    socket.emit("joined", { name: cleanName, phase: state.phase });
    broadcastLobby();

    if (state.phase === "question") {
      const q = currentQuestion();
      const elapsed = (Date.now() - state.questionStartAt) / 1000;
      const remaining = Math.max(0, q.timeLimit - elapsed);
      socket.emit("question", {
        index: state.qIndex,
        total: questions.length,
        question: q.question,
        choices: q.choices,
        timeLimit: remaining,
      });
    }
  });

  socket.on("answer", ({ choiceIndex }) => {
    const p = state.players.get(socket.id);
    if (!p || state.phase !== "question") return;
    if (p.answered) return;
    const q = currentQuestion();
    if (typeof choiceIndex !== "number" || choiceIndex < 0 || choiceIndex >= q.choices.length) return;

    p.answered = true;
    p.answerIndex = choiceIndex;
    p.answerTime = Date.now();

    const elapsed = (p.answerTime - state.questionStartAt) / 1000;
    const remainingFrac = Math.max(0, (q.timeLimit - elapsed) / q.timeLimit);
    const correct = choiceIndex === q.correctIndex;
    const gain = correct ? Math.round(500 + 500 * remainingFrac) : 0;
    p.lastGain = gain;
    p.score += gain;

    socket.emit("answerReceived", { choiceIndex });

    const answeredCount = Array.from(state.players.values()).filter((x) => x.answered).length;
    io.to("host").emit("host:answerProgress", {
      answeredCount,
      totalPlayers: state.players.size,
    });

    maybeEarlyReveal();
  });

  socket.on("host:auth", ({ key }, cb) => {
    if (key === HOST_KEY) {
      socket.join("host");
      cb && cb({ ok: true });
      broadcastLobby();
    } else {
      cb && cb({ ok: false });
    }
  });

  socket.on("host:start", () => {
    if (!socket.rooms.has("host")) return;
    if (state.players.size === 0) return;
    startQuestion(0);
  });

  socket.on("host:next", () => {
    if (!socket.rooms.has("host")) return;
    startQuestion(state.qIndex + 1);
  });

  socket.on("host:reset", () => {
    if (!socket.rooms.has("host")) return;
    resetGame();
  });

  socket.on("disconnect", () => {
    if (state.players.has(socket.id)) {
      state.players.delete(socket.id);
      broadcastLobby();
      maybeEarlyReveal();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Quiz server running on port ${PORT}`);
  console.log(`Host key: ${HOST_KEY}`);
  console.log(`Player link:  http://localhost:${PORT}/player.html`);
  console.log(`Host link:    http://localhost:${PORT}/host.html?key=${HOST_KEY}`);
});
