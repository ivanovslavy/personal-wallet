// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";
import {Handler} from "./Handler.sol";

/**
 * Invariant campaign for PersonalWallet.
 *
 * The 148 Hardhat tests check scenarios a human thought of. This checks RULES, against call
 * sequences nobody thought of: the fuzzer picks handler functions and arguments at random, runs
 * `depth` of them per run, `runs` times, and after every single call asserts that none of the rules
 * below has been broken. A rule here is not "the contract should"; it is "if this is ever false the
 * wallet is broken and money can move wrongly".
 */
contract PersonalWalletInvariants is Test {
    PersonalWallet internal w;
    MockUSDC internal usdc;
    Handler internal h;

    address internal o1 = address(0xA11CE);
    address internal o2 = address(0xB0B);
    address internal o3 = address(0xCA401);
    address internal allowedTo = address(0xD35717);

    function setUp() public {
        usdc = new MockUSDC();

        address[] memory recips = new address[](1);
        string[] memory recipLabels = new string[](1);
        recips[0] = allowedTo; recipLabels[0] = "seed";

        address[] memory toks = new address[](1);
        string[] memory tokLabels = new string[](1);
        toks[0] = address(usdc); tokLabels[0] = "USDC";

        // STRICT on both registries — the configuration the live wallets actually run.
        w = new PersonalWallet([o1, o2, o3], true, true, recips, recipLabels, toks, tokLabels);

        h = new Handler(w, usdc, [o1, o2, o3], allowedTo);
        vm.deal(address(h), 1000 ether);

        targetContract(address(h));
        // Only the handler drives the system; nothing calls the wallet directly.
        bytes4[] memory sel = new bytes4[](22);
        sel[0]  = Handler.depositNative.selector;
        sel[1]  = Handler.depositToken.selector;
        sel[2]  = Handler.proposeNative.selector;
        sel[3]  = Handler.proposeERC20.selector;
        sel[4]  = Handler.proposeAllowRecipient.selector;
        sel[5]  = Handler.proposeOwnerReplacement.selector;
        sel[6]  = Handler.proposeSetPolicy.selector;
        sel[7]  = Handler.confirm.selector;
        sel[8]  = Handler.revokeConfirmation.selector;
        sel[9]  = Handler.veto.selector;
        sel[10] = Handler.cancel.selector;
        sel[11] = Handler.acceptOwnerReplacement.selector;
        sel[12] = Handler.executeNative.selector;
        sel[13] = Handler.executeERC20.selector;
        sel[14] = Handler.warp.selector;
        // These three were MISSING from the first campaign, so their whole branch of the state
        // machine — the timelocked, vetoable one — was never driven at all.
        sel[15] = Handler.executeAllowRecipient.selector;
        sel[16] = Handler.executeOwnerReplacement.selector;
        sel[17] = Handler.executeSetPolicy.selector;
        sel[18] = Handler.confirmAll.selector;
        sel[19] = Handler.executeAnything.selector;
        sel[20] = Handler.acceptAll.selector;
        sel[21] = Handler.warpPastTimelock.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    // 1 — the shape of ownership can never change: always three, distinct, none zero.
    function invariant_ownersAreAlwaysThreeDistinctNonZero() public view {
        address[3] memory o = w.owners();
        assertTrue(o[0] != address(0) && o[1] != address(0) && o[2] != address(0), "zero owner");
        assertTrue(o[0] != o[1] && o[1] != o[2] && o[0] != o[2], "duplicate owner");
        assertEq(w.OWNER_COUNT(), 3, "OWNER_COUNT moved");
        assertEq(w.THRESHOLD(), 2, "THRESHOLD moved");
        assertEq(w.UNANIMOUS(), 3, "UNANIMOUS moved");
    }

    // 2 — nothing executes twice. A replayed execute is a double spend.
    function invariant_nothingExecutesTwice() public view {
        assertEq(h.doubleExecutions(), 0, "a proposal executed twice");
    }

    // 3 — nothing executes with fewer confirmations than its kind requires.
    function invariant_neverUnderConfirmed() public view {
        assertEq(h.underConfirmed(), 0, "executed below the confirmation threshold");
    }

    // 4 — a timelocked proposal never executes before it matures. This is what makes the veto usable.
    function invariant_timelockIsNeverSkipped() public view {
        assertEq(h.earlyTimelock(), 0, "executed before effectiveAt");
    }

    // 5 — a vetoed or cancelled proposal is dead for good.
    function invariant_vetoIsFinal() public view {
        assertEq(h.executedAfterCancel(), 0, "executed after veto/cancel");
    }

    // 6 — an expired proposal never executes.
    function invariant_expiredNeverExecutes() public view {
        assertEq(h.expiredExecuted(), 0, "executed after expiry");
    }

    // 7 — THE ONE THAT GUARDS THE MONEY. In strict mode nothing leaves to an address that was not
    //     on the allowlist at the moment of the transfer — this is the control that survives two
    //     compromised keys.
    function invariant_strictModeNeverPaysAnOutsider() public view {
        assertEq(h.toNonAllowlisted(), 0, "paid a non-allowlisted address while strict");
    }

    // 8 — native accounting: what is inside equals what went in minus what the contract sent out.
    function invariant_nativeBalanceIsAccountedFor() public view {
        assertEq(address(w).balance, h.nativeIn() - h.nativeOut(), "native balance drifted");
        assertEq(w.nativeBalance(), address(w).balance, "nativeBalance() disagrees with the EVM");
    }

    // 9 — no proposal is both executed and cancelled; the states are exclusive.
    function invariant_executedAndCancelledAreExclusive() public view {
        uint256 n = w.proposalCount();
        uint256 lim = n > 40 ? 40 : n;            // keep the per-call cost sane
        for (uint256 i = n > 40 ? n - 40 : 1; i <= n && i <= n; i++) {
            if (lim == 0) break;
            PersonalWallet.Proposal memory p = w.getProposal(i);
            assertFalse(p.executed && p.cancelled, "both executed and cancelled");
        }
    }

    function afterInvariant() public view {
        console2.log("calls driven        :", h.calls());
        console2.log("proposals created   :", h.proposalsMade());
        console2.log("executions allowed  :", h.executions());
        console2.log("wallet native (wei) :", address(w).balance);
        console2.log("proposalCount       :", w.proposalCount());
        console2.log("saw executable      :", h.sawExecutable());
        console2.log("max confirmations   :", h.maxConfirms());
        console2.log("ids tracked         :", h.idCount());
    }
}
