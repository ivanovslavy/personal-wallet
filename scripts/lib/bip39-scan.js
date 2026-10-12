#!/usr/bin/env node
"use strict";
/**
 * Looks for a real BIP-39 mnemonic in a file.
 *
 * Shape alone is not enough: "the function now measures the balance before and after and emits
 * what actually" is twelve lowercase words and matched a shape-based regex. A mnemonic is twelve
 * or twenty-four words drawn from a fixed 2048-word list, so the list is the test. ethers ships
 * that list, and it also validates the checksum — which is what separates a genuine seed phrase
 * from a coincidence.
 *
 *   node scripts/lib/bip39-scan.js <file> [...]
 * Prints "file:line" for each hit and exits 1 if anything was found.
 */
const fs = require("fs");
const { Mnemonic, wordlists } = require("ethers");

const WORDS = new Set(wordlists.en ? Array.from({ length: 2048 }, (_, i) => wordlists.en.getWord(i)) : []);
if (WORDS.size !== 2048) {
  console.error("bip39-scan: could not load the English wordlist — refusing to report 'clean'");
  process.exit(2);
}

let hits = 0;
for (const file of process.argv.slice(2)) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }

  text.split(/\r?\n/).forEach((line, i) => {
    const words = line.toLowerCase().match(/[a-z]+/g) || [];
    if (words.length < 12) return;
    // Slide a window over the line; a mnemonic can sit inside a longer line.
    for (const len of [24, 12]) {
      for (let s = 0; s + len <= words.length; s++) {
        const win = words.slice(s, s + len);
        if (!win.every((w) => WORDS.has(w))) continue;
        // Every word is in the list. Now the checksum decides.
        const phrase = win.join(" ");
        let valid = false;
        try { valid = Mnemonic.isValidMnemonic(phrase); } catch { valid = false; }
        if (valid) {
          console.log(`${file}:${i + 1}`);
          hits++;
          return;
        }
      }
    }
  });
}
process.exit(hits ? 1 : 0);
