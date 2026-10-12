/**
 * A byte-level grep for an opcode is WRONG: 0xf4 also occurs inside PUSH immediates, inside
 * packed constants and all over the CBOR metadata trailer. The first version of this check
 * reported DELEGATECALL in a contract that has none.
 *
 * This walks the bytecode the way the EVM does — honouring PUSH immediate widths — after cutting
 * off the metadata, and returns the set of opcodes that are genuinely executable.
 */
function executableOpcodes(hexCode) {
  let body = hexCode.startsWith("0x") ? hexCode.slice(2) : hexCode;
  const bytes = Buffer.from(body, "hex");

  // Solidity appends CBOR metadata plus a 2-byte big-endian length. Strip it.
  let end = bytes.length;
  if (bytes.length > 2) {
    const metaLen = bytes.readUInt16BE(bytes.length - 2);
    if (metaLen > 0 && metaLen + 2 <= bytes.length) end = bytes.length - 2 - metaLen;
  }

  const seen = new Set();
  for (let i = 0; i < end; i++) {
    const op = bytes[i];
    seen.add(op);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // PUSH1..PUSH32: skip the immediate
  }
  return seen;
}

module.exports = { executableOpcodes };
