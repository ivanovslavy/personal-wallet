/**
 * solidity-coverage settings — KEPT FOR THE RECORD, BUT THE TOOL CANNOT RUN ON THIS CONTRACT.
 *
 * This contract is large, and the instrumented artefact is enormous: with full instrumentation
 * its initcode measured 82 199 B on 2026-10-12, against the EIP-3860 cap of 49 152 B that Cancun
 * enforces. `allowUnlimitedContractSize` does NOT lift that — it only touches the EIP-170 runtime
 * cap — and the build cannot target a pre-Shanghai EVM either, because OpenZeppelin 5.6 emits
 * `mcopy` directly and that needs Cancun.
 *
 * Everything below is the smallest instrumented artefact that could be produced: forcing the
 * Yul optimizer on (the tool disables the optimizer by default) brought it from 81 783 B down to
 * 64 307 B — still 15 KB over the cap. The measureXxx flags had no effect on size.
 *
 * `npm run coverage` therefore fails on this contract, and no configuration fixes it. The real
 * measurement lives in `test/00-surface.js`, which proves from OBSERVED TRAFFIC that every
 * external function was actually invoked and every custom error actually returned — run with
 * `npm test`. Nothing was removed from the contract to please a coverage tool.
 */
module.exports = {
  measureStatementCoverage: true,
  measureBranchCoverage: true,
  measureLineCoverage: true,
  measureFunctionCoverage: false,
  measureModifierCoverage: false,
  configureYulOptimizer: true,
  solcOptimizerDetails: { yul: true, yulDetails: { optimizerSteps: "dhfoDgvulfnTUtnIf" } },
  skipFiles: ["mocks/TestTokens.sol", "mocks/Attackers.sol"],
};
