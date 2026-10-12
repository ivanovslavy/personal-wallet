"use strict";
/**
 * Where the listener keeps its place.
 *
 * Written atomically (temp file + rename), because the alternative is a half-written JSON after a
 * power cut on a Raspberry Pi, and a listener that cannot parse its own state file is a listener
 * that silently starts from "now" and loses every event in between.
 *
 * The state is deliberately tiny and human-readable: you must be able to `cat` it and know exactly
 * what the service will do next.
 */
const fs = require("fs");
const path = require("path");

class State {
  constructor(file) {
    this.file = file;
    this.data = { lastBlock: null, startedAt: null, lastPollAt: null, eventsSeen: 0, alertsSent: 0 };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed) this.data = { ...this.data, ...parsed };
    } catch (e) {
      if (e.code !== "ENOENT") {
        // Say so loudly. Starting over quietly is how events go missing.
        console.error(`[state] ${this.file} is unreadable (${e.message}) — starting fresh`);
      }
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }
}

module.exports = { State };
