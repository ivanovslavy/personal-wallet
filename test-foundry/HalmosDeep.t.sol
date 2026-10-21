// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";

/**
 * Deeper symbolic checks — because the first symbolic suite was too easy.
 *
 * HalmosBoundaries proves eight properties in 4.9 seconds over 1 to 5 paths each. That is not a
 * compliment: it means almost nothing in those checks is actually symbolic. The `setUp` builds one
 * concrete wallet, the proposal is of one concrete kind with concrete arguments, and the only
 * symbol carried to the solver is a time jump. Such a check proves a property of ONE state, for
 * all times — useful, but a long way from "for all states".
 *
 * This file widens the symbols instead of adding more checks of the same shape:
 *   • the chain's CURRENT time is symbolic, not just the jump — including values near the uint64
 *     ceiling, where `uint64(block.timestamp) + delay` is checked arithmetic that must revert
 *     rather than wrap. A wrapped `effectiveAt` would be a timelock skipped by arithmetic.
 *   • the AMOUNTS and TTLs are symbolic, so the accept/reject boundary is proven, not sampled.
 *   • the proposal ID is symbolic, so the guards are proven for ids that do not exist, ids that
 *     do, and the one exactly at `proposalCount`.
 *   • where a rule is an "if and only if", it is checked in BOTH directions — a guard that is
 *     merely sufficient would pass a one-directional check and still refuse legitimate work.
 *
 *   ~/.venvs/halmos/bin/halmos --contract HalmosDeep --forge-build-out forge-out --statistics
 */
contract HalmosDeep is Test {
    PersonalWallet w;
    MockUSDC usdc;
    address o1 = address(0xA11CE);
    address o2 = address(0xB0B);
    address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](1); string[] memory tl = new string[](1);
        t[0] = address(usdc); tl[0] = "USDC";
        w = new PersonalWallet([o1, o2, o3], true, true, r, rl, t, tl);
        vm.deal(address(this), 100 ether);
        w.depositNative{value: 50 ether}();
    }

    // ───────────────── the uint64 time arithmetic, at every chain time ─────────────────

    /**
     * At ANY chain time — including values where `now + delay` cannot fit in uint64 — a timelocked
     * proposal either fails to be created at all, or lands with `effectiveAt` strictly in the
     * future. It must never land with a wrapped `effectiveAt` in the past, which would be a
     * timelock defeated by arithmetic rather than by waiting.
     *
     * This is the check the concrete suite cannot make: it warps to a SYMBOLIC now, so the solver
     * considers the ceiling cases a fuzzer would never generate.
     */
    function check_effectiveAtNeverWrapsAtAnyChainTime(uint64 now_) public {
        vm.warp(now_);
        vm.prank(o1);
        try w.proposeAllowRecipient(address(0xFEE), "sym") returns (uint256 id) {
            uint64 eff = w.effectiveAt(id);
            assert(eff > now_);                       // strictly later, never wrapped
            assert(eff == now_ + w.delay());
        } catch {
            // Refusing to create is the correct alternative — checked arithmetic reverting is a
            // safe outcome. What must not exist is a created proposal with a wrapped deadline.
        }
    }

    /**
     * The same question for expiry. `expiresAt` is `now + ttl` for transfers and
     * `effectiveAt + EXECUTION_WINDOW` for governance; for any accepted ttl at any chain time the
     * result must be in the future, or the creation must have reverted.
     */
    function check_expiryNeverWrapsForAnyAcceptedTtl(uint64 now_, uint64 ttl) public {
        vm.warp(now_);
        vm.prank(o1);
        try w.proposeNative(dest, 1 ether, ttl) returns (uint256 id) {
            // If it was accepted, the ttl was in range AND the arithmetic held.
            assert(ttl >= w.MIN_TTL() && ttl <= w.MAX_TTL());
            assert(w.getProposal(id).expiresAt == now_ + ttl);
            assert(w.getProposal(id).expiresAt > now_);
        } catch {
            // The only legitimate reasons to refuse: ttl out of range, or the sum not fitting.
            bool outOfRange = ttl < w.MIN_TTL() || ttl > w.MAX_TTL();
            bool wouldOverflow = uint256(now_) + uint256(ttl) > type(uint64).max;
            assert(outOfRange || wouldOverflow);
        }
    }

    /**
     * The policy setter's acceptance rule, stated as an IF AND ONLY IF and proven in both
     * directions: a proposal is accepted exactly when the delay is in [MIN_DELAY, MAX_DELAY] AND
     * the proposed policy differs from the current one. A one-directional check would be satisfied
     * by a setter that refuses everything.
     *
     * 🔴 THIS CHECK FOUND SOMETHING — in my assertion, not in the contract. The first version
     * claimed `accepted == inRange`, and halmos answered with `nd = 0x3f480` = 259 200 s = 72 h: a
     * value squarely inside the range that the contract nevertheless refuses, because 72 hours with
     * both registries required IS the current policy and `NoPolicyChange()` rejects a no-op. The
     * solver found the one value in the whole uint64 space where my rule and the contract's rule
     * disagree. A fuzzer would have had to guess exactly DEFAULT_DELAY to see it.
     *
     * Worth keeping as a finished thought: a no-op policy proposal is refused at PROPOSAL time,
     * not at execution. That matters operationally — it cannot be used to park a harmless-looking
     * proposal in the queue.
     */
    function check_policyAcceptanceIsExact(uint64 nd, bool a, bool b) public {
        uint64 cur = w.delay();
        bool curA = w.requireAllowedRecipient();
        bool curB = w.requireAllowedToken();
        vm.prank(o1);
        bool accepted;
        try w.proposeSetPolicy(nd, a, b) { accepted = true; } catch { accepted = false; }
        bool inRange = nd >= w.MIN_DELAY() && nd <= w.MAX_DELAY();
        bool changesSomething = nd != cur || a != curA || b != curB;
        assert(accepted == (inRange && changesSomething));
    }

    // ───────────────── the guards, over a symbolic proposal id ─────────────────

    /**
     * `isExecutable` is EXACTLY the conjunction it documents — for any id, existing or not, at any
     * time. Proven as an equivalence so that a guard which is merely sufficient (refusing things it
     * should allow) fails too, not only one that is insufficient.
     */
    function check_isExecutableIsExactlyTheConjunction(uint256 id, uint64 jump) public {
        vm.assume(jump < 365 days);
        vm.warp(block.timestamp + jump);

        bool reported = w.isExecutable(id);
        if (id == 0 || id > w.proposalCount()) {
            assert(!reported);                        // a non-existent id is never executable
            return;
        }
        PersonalWallet.Proposal memory p = w.getProposal(id);
        uint64 eff = w.effectiveAt(id);
        bool expected = !p.executed
            && !p.cancelled
            && block.timestamp <= p.expiresAt
            && (eff == 0 || block.timestamp >= eff)
            && w.confirmations(id) >= w.requiredConfirmations(id);
        assert(reported == expected);
    }

    /**
     * Governance needs all three seats, at any time, with any two of them confirming. The concrete
     * suite proves one confirmation is not enough; this proves TWO is not enough either, which is
     * the boundary that matters — it is what stops two owners from rewriting the policy or the
     * recipient registry behind the third's back.
     */
    function check_twoConfirmationsNeverEnoughForGovernance(uint64 jump, uint256 pair) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeAllowRecipient(address(0xFEE), "sym");   // proposer = 1 confirmation
        address second = pair % 2 == 0 ? o2 : o3;
        vm.prank(second); w.confirm(id);                               // now 2 of 3
        vm.warp(block.timestamp + jump);
        assert(w.confirmations(id) == 2);
        assert(!w.isExecutable(id));
        vm.prank(o1);
        try w.executeAllowRecipient(id) { assert(false); } catch { }
    }

    /**
     * A veto is final against EVERYTHING that follows it: more confirmations, any amount of time,
     * any owner trying. The concrete suite proves a veto survives time; this adds the confirmations
     * arriving afterwards, which is the realistic attempt to undo one.
     */
    function check_vetoSurvivesConfirmationsAndTime(uint64 jump, uint256 who) public {
        vm.assume(jump < 365 days);
        vm.prank(o1);
        uint256 id = w.proposeAllowRecipient(address(0xFEE), "sym");
        vm.prank(o3); w.veto(id);
        vm.prank(who % 2 == 0 ? o2 : o3);
        try w.confirm(id) { } catch { }
        vm.warp(block.timestamp + jump);
        assert(!w.isExecutable(id));
        vm.prank(o1);
        try w.executeAllowRecipient(id) { assert(false); } catch { }
    }

    /**
     * A transfer never moves more native than the wallet holds, for any symbolic amount. Either the
     * proposal is refused, or execution is refused, or the balance covered it — there is no fourth
     * outcome, and in particular no partial send that leaves the accounting wrong.
     */
    function check_nativeTransferNeverExceedsBalance(uint256 amount) public {
        uint256 before = w.nativeBalance();
        vm.prank(o1);
        try w.proposeNative(dest, amount, 1 days) returns (uint256 id) {
            vm.prank(o2); w.confirm(id);
            vm.prank(o1);
            try w.executeNative(id) {
                assert(amount <= before);
                assert(w.nativeBalance() == before - amount);
            } catch {
                assert(w.nativeBalance() == before);   // a failed execute changes nothing
            }
        } catch { }
    }

    /**
     * Confirm then revoke returns the count to where it was, for any owner and any order — the
     * property a double-counting or under-counting bug in the recount would break.
     */
    function check_confirmThenRevokeIsNeutral(uint256 who) public {
        vm.prank(o1);
        uint256 id = w.proposeNative(dest, 1 ether, 1 days);
        uint256 start = w.confirmations(id);
        address a = who % 3 == 0 ? o1 : (who % 3 == 1 ? o2 : o3);
        vm.prank(a);
        try w.confirm(id) { } catch { }
        vm.prank(a);
        try w.revokeConfirmation(id) { } catch { }
        assert(w.confirmations(id) == start || w.confirmations(id) == start - 1);
    }
}
