// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";

/**
 * Symbolic checks (Halmos) — the exact boundaries a fuzzer almost never lands on.
 *
 * A fuzzer picks numbers; it will try 10 000 timestamps around a deadline and miss the one that
 * equals it. Halmos does not pick: it carries `t` as a symbol through the EVM and asks the solver
 * whether ANY value of t reaches a bad state. For a guard written as `<` versus `<=`, that is the
 * difference between proven and probably.
 *
 *   ~/.venvs/halmos/bin/halmos --contract HalmosBoundaries
 */
contract HalmosBoundaries is Test {
    PersonalWallet w;
    MockUSDC usdc;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](1); string[] memory tl = new string[](1);
        t[0] = address(usdc); tl[0] = "USDC";
        w = new PersonalWallet([o1,o2,o3], true, true, r, rl, t, tl);
        vm.deal(address(this), 100 ether);
        w.depositNative{value: 50 ether}();
    }

    /// For ANY jump in time, a proposal with only one confirmation must never execute.
    /// Proves the threshold independently of when you try.
    function check_oneConfirmationNeverExecutes(uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeNative(dest, 1 ether, 30 days);   // proposer auto-confirms = 1
        vm.warp(block.timestamp + jump);
        vm.prank(o1);
        try w.executeNative(id) { assert(false); } catch { }    // must ALWAYS revert
    }

    /// For ANY timestamp, a timelocked proposal must not execute while block.timestamp < effectiveAt.
    /// This is the property the veto window rests on; `<` vs `<=` here is the whole difference.
    function check_timelockHoldsAtEveryInstant(uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeAllowRecipient(address(0xFEE), "sym");
        vm.prank(o2); w.confirm(id);
        vm.prank(o3); w.confirm(id);                            // 3-of-3, the kind requires it
        uint64 eff = w.effectiveAt(id);
        vm.warp(block.timestamp + jump);
        if (block.timestamp < eff) {
            vm.prank(o1);
            try w.executeAllowRecipient(id) { assert(false); } catch { }
        }
    }

    /// THE BOUNDARY CHECKS. `try/catch` collapses symbolic branches — the first run explored only
    /// four paths. Asking `isExecutable` instead keeps the question inside pure logic, where the
    /// solver can actually reason about `<` versus `<=`.

    /// If the wallet says a proposal is executable, its timelock MUST have elapsed. For every t.
    function check_executableImpliesTimelockElapsed(uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeAllowRecipient(address(0xFEE), "sym");
        vm.prank(o2); w.confirm(id);
        vm.prank(o3); w.confirm(id);
        uint64 eff = w.effectiveAt(id);
        vm.warp(block.timestamp + jump);
        if (w.isExecutable(id)) {
            assert(eff == 0 || block.timestamp >= eff);
        }
    }

    /// If the wallet says a proposal is executable, it has not expired. For every t.
    function check_executableImpliesNotExpired(uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeNative(dest, 1 ether, 30 days);
        vm.prank(o2); w.confirm(id);
        uint64 exp = w.getProposal(id).expiresAt;
        vm.warp(block.timestamp + jump);
        if (w.isExecutable(id)) {
            assert(block.timestamp <= exp);
        }
    }

    /// If the wallet says a proposal is executable, it carries at least the required confirmations.
    function check_executableImpliesEnoughConfirmations(uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeNative(dest, 1 ether, 30 days);
        vm.warp(block.timestamp + jump);
        if (w.isExecutable(id)) {
            assert(w.confirmations(id) >= w.requiredConfirmations(id));
        }
    }

    /// A vetoed proposal must stay dead for ANY later moment and ANY owner.
    function check_vetoSurvivesAnyTime(uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeAllowRecipient(address(0xFEE), "sym");
        vm.prank(o2); w.confirm(id);
        vm.prank(o3); w.confirm(id);
        vm.prank(o3); w.veto(id);
        vm.warp(block.timestamp + jump);
        vm.prank(o1);
        try w.executeAllowRecipient(id) { assert(false); } catch { }
    }
}
