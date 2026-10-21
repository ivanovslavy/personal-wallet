// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PersonalWallet} from "../../contracts/PersonalWallet.sol";
import {MockUSDC} from "../../contracts/mocks/TestTokens.sol";

/**
 * Medusa harness — a SECOND fuzzer, and deliberately NOT a copy of the Foundry campaign.
 *
 * WHY A SECOND FUZZER AT ALL. The Foundry campaign explores orderings of calls the handler has
 * already shaped into something the contract accepts. That is how a state-machine bug is found,
 * but it also means every input the wallet ever sees has passed through MY assumptions. If one of
 * those assumptions is wrong, the campaign is blind in exactly that direction and will still
 * report green. A second tool with a different search strategy and an INDEPENDENTLY written
 * harness is the only way to test the harness itself.
 *
 * WHAT IS DIFFERENT HERE, concretely:
 *   • Medusa calls PersonalWallet DIRECTLY — no handler, no bounding, no pranking. Arguments are
 *     raw fuzzer output: unbounded amounts, unbounded ttls, garbage addresses, ids that do not
 *     exist. The Foundry handler never does this.
 *   • The callers are medusa's own sender set, which IS the owner set (see medusa.json), so the
 *     fuzzer is three owners acting in arbitrary interleavings plus an outsider.
 *   • The search is coverage-guided with a persistent corpus across runs, mutating whole call
 *     SEQUENCES. Foundry restarts from a clean slate every run.
 *
 * WHAT CAN AND CANNOT BE EXPRESSED. Medusa evaluates `property_*` after every call, so the rules
 * here must be STATE properties — true of the storage at rest. Transition rules ("it was not
 * early AT THE MOMENT it executed") cannot be observed this way, and are left to Foundry, which
 * records ghosts at the moment of the call. The two suites are therefore complements, not
 * duplicates, and this file says which rules it does NOT cover rather than pretending to cover
 * them:
 *      covered here  → owners, confirmation sufficiency, executed/cancelled exclusivity,
 *                      registry coherence and containment, native and token accounting
 *      Foundry only  → timelock-at-execution, expiry-at-execution, double-execution,
 *                      strict-mode-at-execution, hostile-owner outcomes, differential vs a
 *                      reference model, and the whole ERC-721/ERC-1155 surface — this harness
 *                      deploys only a fungible token, so the NFT batch paths are NOT fuzzed here
 */
/// The medusa cheatcode surface this harness needs. Declared locally rather than importing
/// forge-std, so the file has no test-framework dependency.
interface IVm {
    function prank(address) external;
    function warp(uint256) external;
}

contract MedusaProps {
    PersonalWallet public w;
    MockUSDC public usdc;

    // Must match `fuzzing.senderAddresses` in medusa.json — those accounts ARE the owners.
    address constant O1 = address(0x0000000000000000000000000000000000010000);
    address constant O2 = address(0x0000000000000000000000000000000000020000);
    address constant O3 = address(0x0000000000000000000000000000000000030000);
    address constant RECIP = address(0x00000000000000000000000000000000000ACCE9);

    constructor() payable {
        address[3] memory o = [O1, O2, O3];
        address[] memory recips = new address[](1);
        string[] memory rlabels = new string[](1);
        recips[0] = RECIP; rlabels[0] = "allowed";

        usdc = new MockUSDC();
        address[] memory toks = new address[](1);
        string[] memory tlabels = new string[](1);
        toks[0] = address(usdc); tlabels[0] = "USDC";

        // Strict policy — the harder configuration. A weaker one would hide the registry rules.
        w = new PersonalWallet(o, true, true, recips, rlabels, toks, tlabels);

        usdc.mint(address(w), 1_000_000e6);
        payable(address(w)).transfer(address(this).balance);
    }

    receive() external payable {}


    // ───────────────────────────── the action surface ─────────────────────────────
    //
    // WHY THESE EXIST AT ALL — a trap worth remembering. The first version of this file had ONLY
    // properties, on the belief that medusa fuzzes dynamically deployed contracts. It does not:
    // `targetContracts` is the whole world, so medusa spent 400 000 calls invoking `w()` and
    // `usdc()` and nothing else. All ten tests reported PASSED. The campaign was worthless.
    //
    // It was caught by a CANARY: a property asserting `proposalCount() == 0`, which is false the
    // instant anything real happens. It passed — proving nothing real had happened. Any green
    // fuzzing result is meaningless until a deliberately-false property has been shown to fail.
    //
    // WHAT MAKES THESE DIFFERENT FROM THE FOUNDRY HANDLER. They bound NOTHING. Amounts, ttls,
    // recipients, token addresses and proposal ids go to the wallet exactly as the fuzzer produced
    // them — unbounded uint256 amounts, ids that do not exist, ttls of zero, the wallet's own
    // address as a destination. The Foundry handler deliberately shapes inputs into the forms the
    // contract accepts, so that campaign explores ORDERINGS; this one explores ARGUMENTS. Reverts
    // are expected and are not failures — what matters is that no property breaks.

    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function _as(uint256 seed) internal {
        address[3] memory o = w.owners();
        vm.prank(o[seed % 3]);
    }

    function fuzz_proposeNative(uint256 seed, address to, uint256 amount, uint64 ttl) public {
        _as(seed); w.proposeNative(to, amount, ttl);
    }
    function fuzz_proposeERC20(uint256 seed, address to, uint256 amount, uint64 ttl, bool realToken) public {
        _as(seed); w.proposeERC20(realToken ? address(usdc) : to, to, amount, ttl);
    }
    function fuzz_proposeAllowRecipient(uint256 seed, address r) public {
        _as(seed); w.proposeAllowRecipient(r, "fuzz");
    }
    function fuzz_proposeRevokeRecipient(uint256 seed, address r) public {
        _as(seed); w.proposeRevokeRecipient(r);
    }
    function fuzz_proposeAllowToken(uint256 seed, address t) public {
        _as(seed); w.proposeAllowToken(t, "fuzz");
    }
    function fuzz_proposeRevokeToken(uint256 seed, address t) public {
        _as(seed); w.proposeRevokeToken(t);
    }
    function fuzz_proposeOwnerReplacement(uint256 seed, uint256 which, address nw) public {
        address[3] memory o = w.owners();
        _as(seed); w.proposeOwnerReplacement(o[which % 3], nw);
    }
    function fuzz_proposeSetPolicy(uint256 seed, uint64 d, bool a, bool b) public {
        _as(seed); w.proposeSetPolicy(d, a, b);
    }

    function fuzz_confirm(uint256 seed, uint256 id) public { _as(seed); w.confirm(id); }
    function fuzz_revoke(uint256 seed, uint256 id) public { _as(seed); w.revokeConfirmation(id); }
    function fuzz_veto(uint256 seed, uint256 id) public { _as(seed); w.veto(id); }
    function fuzz_cancel(uint256 seed, uint256 id) public { _as(seed); w.cancel(id); }
    function fuzz_accept(uint256 id, uint256 which) public {
        address[3] memory o = w.owners();
        vm.prank(o[which % 3]); w.acceptOwnerReplacement(id);
    }

    function fuzz_executeNative(uint256 seed, uint256 id) public { _as(seed); w.executeNative(id); }
    function fuzz_executeERC20(uint256 seed, uint256 id) public { _as(seed); w.executeERC20(id); }
    function fuzz_executeAllowRecipient(uint256 seed, uint256 id) public { _as(seed); w.executeAllowRecipient(id); }
    function fuzz_executeRevokeRecipient(uint256 seed, uint256 id) public { _as(seed); w.executeRevokeRecipient(id); }
    function fuzz_executeAllowToken(uint256 seed, uint256 id) public { _as(seed); w.executeAllowToken(id); }
    function fuzz_executeRevokeToken(uint256 seed, uint256 id) public { _as(seed); w.executeRevokeToken(id); }
    function fuzz_executeOwnerReplacement(uint256 seed, uint256 id) public { _as(seed); w.executeOwnerReplacement(id); }
    function fuzz_executeSetPolicy(uint256 seed, uint256 id) public { _as(seed); w.executeSetPolicy(id); }

    /// Time must move or nothing timelocked can ever mature — and the default delay is 24 h.
    function fuzz_warp(uint256 secs) public { vm.warp(block.timestamp + (secs % (30 days)) + 1); }

    function fuzz_depositNative(uint256 amt) public {
        uint256 v = amt % (address(this).balance + 1);
        w.depositNative{value: v}();
    }
    function fuzz_depositToken(uint256 amt) public {
        usdc.mint(address(this), amt % 1e12);
        usdc.approve(address(w), type(uint256).max);
        usdc.transfer(address(w), amt % 1e12);
    }


    // ──────────────── reaching the states where the rules actually bite ────────────────
    //
    // The unbounded functions above explore ARGUMENTS, and that is their whole job. But a random
    // uint256 id never lands on a live proposal twice, so with only those the campaign made 1
    // proposal in 400 000 calls and executed NOTHING — the second canary proved it. The properties
    // about executed proposals were passing on an empty set.
    //
    // These few functions are therefore deliberately BOUNDED: they aim at real ids, gather real
    // confirmations and move time past the real timelock. They do not decide WHETHER the contract
    // allows something — they only make the interesting state reachable, which is the one thing a
    // fuzzer cannot discover by luck. The checking still happens in the properties.

    function _realId(uint256 seed) internal view returns (uint256) {
        uint256 n = w.proposalCount();
        return n == 0 ? 0 : (seed % n) + 1;
    }

    /// A payment with every argument legal, so the queue contains something that CAN execute.
    function fuzz_proposeLegalNative(uint256 seed, uint256 amt, uint64 ttl) public {
        uint256 bal = w.nativeBalance();
        if (bal == 0) return;
        _as(seed);
        w.proposeNative(RECIP, (amt % bal) + 1, uint64(1 hours + (ttl % 6 days)));
    }

    function fuzz_proposeLegalERC20(uint256 seed, uint256 amt, uint64 ttl) public {
        uint256 bal = w.erc20Balance(address(usdc));
        if (bal == 0) return;
        _as(seed);
        w.proposeERC20(address(usdc), RECIP, (amt % bal) + 1, uint64(1 hours + (ttl % 6 days)));
    }

    /// The newest ids, so a sweep stays bounded as the queue grows. 32 is well past the point
    /// where a 120-call sequence could have created more live proposals than this.
    function _window() internal view returns (uint256 lo, uint256 hi) {
        hi = w.proposalCount();
        lo = hi > 32 ? hi - 31 : 1;
    }

    /**
     * Every owner confirms EVERY live id — not one picked id.
     *
     * Measured, not assumed: with a single `seed % proposalCount` pick, a 20-minute campaign of
     * 739 459 calls left `executeNative` and `executeERC20` with ZERO line coverage. Governance
     * proposals executed; not one payment ever did, because reaching "executable" needs propose,
     * two confirmations and an execute to land on the SAME id, and that is a 1/n coincidence
     * repeated three times. Sweeping removes the coincidence while leaving the fuzzer in charge of
     * when it happens and of everything that happened before.
     */
    function fuzz_confirmAll(uint256) public {
        (uint256 lo, uint256 hi) = _window();
        address[3] memory o = w.owners();
        for (uint256 id = lo; id <= hi; ++id)
            for (uint256 i; i < 3; ++i) { vm.prank(o[i]); try w.confirm(id) {} catch {} }
    }

    /// Jump just past a real proposal's timelock — the only way the timelocked branch is reached.
    function fuzz_warpPastTimelock(uint256 seed) public {
        uint256 id = _realId(seed);
        if (id == 0) return;
        uint64 eff = w.effectiveAt(id);
        if (eff > block.timestamp) vm.warp(uint256(eff) + 1);
    }

    /// Accept pending owner replacements, so that branch can reach "executable" at all.
    function fuzz_acceptAll(uint256) public {
        (uint256 lo, uint256 hi) = _window();
        for (uint256 id = lo; id <= hi; ++id) {
            address to = w.getProposal(id).to;
            if (to == address(0)) continue;
            vm.prank(to);
            try w.acceptOwnerReplacement(id) {} catch {}
        }
    }

    /**
     * Execute whatever is ready, trying every door for one real id.
     *
     * Picking one kind per attempt means four out of five calls hit WrongKind and the ready
     * proposals stay unexecuted — the mistake that made three Foundry campaigns and the first two
     * medusa campaigns worthless. An operator does not guess either; they execute what is ready.
     */
    function fuzz_executeAnything(uint256 seed) public {
        (uint256 lo, uint256 hi) = _window();
        address[3] memory o = w.owners();
        for (uint256 id = lo; id <= hi; ++id) {
            // `(seed + id) % 3` overflows when the fuzzer hands over 2**256-1 — medusa's assertion
            // mode caught that as an arithmetic panic in THIS file. Reduce first, then add.
            address caller = o[((seed % 3) + id) % 3];
            vm.prank(caller); try w.executeNative(id) {} catch {}
            vm.prank(caller); try w.executeERC20(id) {} catch {}
            vm.prank(caller); try w.executeAllowRecipient(id) {} catch {}
            vm.prank(caller); try w.executeRevokeRecipient(id) {} catch {}
            vm.prank(caller); try w.executeAllowToken(id) {} catch {}
            vm.prank(caller); try w.executeRevokeToken(id) {} catch {}
            vm.prank(caller); try w.executeSetPolicy(id) {} catch {}
            vm.prank(caller); try w.executeOwnerReplacement(id) {} catch {}
        }
    }

    // ─────────────────────────────── properties ───────────────────────────────

    // 🐤 PROOF OF LIFE — run these two before trusting any green result from this file. Both are
    // deliberately FALSE once the campaign does anything real, so both must FAIL. They are how the
    // vacuous campaigns were caught: the first version of this harness reported 10/10 PASSED while
    // never once calling the wallet, and the second made exactly 1 proposal and executed nothing.
    //
    //   function property_CANARY_noProposalEverMade() public view returns (bool) {
    //       return w.proposalCount() == 0;
    //   }
    //   function property_CANARY_nothingEverExecuted() public view returns (bool) {
    //       uint256 n = w.proposalCount();
    //       for (uint256 id = 1; id <= n; ++id) if (w.getProposal(id).executed) return false;
    //       return true;
    //   }
    //
    // Last verified 2026-10-21: both FAILED (proposal made at call 7, execution reached) — the
    // campaign genuinely drives the wallet.

    /// The three owner seats are always three distinct, non-zero addresses that are not the wallet.
    function property_ownersAreThreeDistinctNonZero() public view returns (bool) {
        address[3] memory o = w.owners();
        for (uint256 i; i < 3; ++i) {
            if (o[i] == address(0) || o[i] == address(w)) return false;
            if (!w.isOwner(o[i])) return false;
            for (uint256 j = i + 1; j < 3; ++j) if (o[i] == o[j]) return false;
        }
        return true;
    }

    /**
     * Anything marked executed carries at least the confirmations it needed — WHILE THE OWNER SET
     * IS STILL THE ORIGINAL ONE.
     *
     * 🔴 THAT CAVEAT IS NOT A WEAKENING, IT IS THE CONTRACT'S DESIGN. The first version of this
     * property had no caveat and medusa produced a five-call counterexample: proposal 1
     * (ALLOW_RECIPIENT) executed legitimately with its three confirmations, then proposal 2
     * (OWNER_REPLACE) executed and replaced `0x10000` — one of proposal 1's confirmers. Because
     * `_confirmations` counts over the CURRENT owners by design, `confirmations(1)` then reads 2
     * against a requirement of 3, and a correctly executed proposal looks under-confirmed in
     * hindsight.
     *
     * The recount is deliberate ("Counted over the current owners on purpose", and
     * HalmosBoundaries proves `check_replacedOwnersVoteStopsCounting`): a departed owner's vote
     * must not keep authorising anything. The lesson is about the property, not the contract —
     * "executed ⇒ sufficiently confirmed" is a TRANSITION rule wearing a state rule's clothes,
     * because its right-hand side is re-evaluated against a mutable set. Stated as a state rule it
     * holds only while that set is unchanged; the unconditional version belongs in Foundry, which
     * records the count at the moment of the call.
     */
    function property_executedWasSufficientlyConfirmed() public view returns (bool) {
        address[3] memory o = w.owners();
        if (o[0] != O1 || o[1] != O2 || o[2] != O3) return true;   // see above: not a state rule
        uint256 n = w.proposalCount();
        for (uint256 id = 1; id <= n; ++id) {
            if (!w.getProposal(id).executed) continue;
            if (w.confirmations(id) < w.requiredConfirmations(id)) return false;
        }
        return true;
    }

    /// Executed and cancelled are mutually exclusive, forever, for every proposal.
    function property_executedAndCancelledExclusive() public view returns (bool) {
        uint256 n = w.proposalCount();
        for (uint256 id = 1; id <= n; ++id) {
            PersonalWallet.Proposal memory p = w.getProposal(id);
            if (p.executed && p.cancelled) return false;
        }
        return true;
    }

    /**
     * Every address the registry lists as currently allowed really answers `isRecipientAllowed`,
     * and the "ever registered" count never drops below the "currently allowed" length.
     *
     * The containment direction matters: `allowedRecipients()` is documented as currently allowed
     * and `registeredRecipientCount()` as ever registered. The first Foundry version of this rule
     * demanded equality, failed, and the contract was right — the test was wrong.
     */
    function property_registriesStayCoherent() public view returns (bool) {
        (address[] memory list,) = w.allowedRecipients();
        if (list.length > w.registeredRecipientCount()) return false;
        for (uint256 i; i < list.length; ++i) if (!w.isRecipientAllowed(list[i])) return false;
        (address[] memory toks,) = w.allowedTokens();
        for (uint256 i; i < toks.length; ++i) if (!w.isTokenAllowed(toks[i])) return false;
        return true;
    }

    /**
     * `isExecutable` agrees with the facts in storage, for every live id and also for ids that do
     * not exist. Checked here as well as symbolically because the two reach it differently: Halmos
     * proves the equivalence for a symbolic id over one concrete state, this one re-checks it over
     * thousands of states the fuzzer actually built.
     *
     * Note for anyone reading the coverage report: `isExecutable` shows ZERO covered lines there
     * even though this runs after every call. Under viaIR medusa's lcov attribution is unreliable
     * for view functions — `owners()` reports zero too, and it is called inside a transaction.
     * Judge this one by the property, not by the report.
     *
     * The confirmation term is left out on purpose — it is re-counted over the current owners, so
     * including it would make this fail after any owner replacement for the reason documented on
     * `property_executedWasSufficientlyConfirmed`. What is asserted is the part that is genuinely
     * state: an executed, cancelled, expired or still-timelocked proposal is NEVER executable, and
     * a non-existent id never is either.
     */
    function property_isExecutableRefusesWhatItMust() public view returns (bool) {
        uint256 n = w.proposalCount();
        if (w.isExecutable(0) || w.isExecutable(n + 1)) return false;
        for (uint256 id = 1; id <= n; ++id) {
            PersonalWallet.Proposal memory p = w.getProposal(id);
            uint64 eff = w.effectiveAt(id);
            bool mustRefuse = p.executed
                || p.cancelled
                || block.timestamp > p.expiresAt
                || (eff != 0 && block.timestamp < eff);
            if (mustRefuse && w.isExecutable(id)) return false;
        }
        return true;
    }

    /// The wallet never claims more native than it actually holds.
    function property_nativeBalanceIsHonest() public view returns (bool) {
        return w.nativeBalance() == address(w).balance;
    }

    /// Nor more of a token than the token itself says it holds.
    function property_tokenBalanceIsHonest() public view returns (bool) {
        return w.erc20Balance(address(usdc)) == usdc.balanceOf(address(w));
    }

    /**
     * An outsider never becomes an allowed recipient without a governance proposal having
     * executed. The seeded RECIP is allowed from birth; anything else being allowed means some
     * `executeAllowRecipient` ran — which is legal. What must NEVER be true is the wallet itself
     * or the zero address being an allowed destination.
     */
    function property_walletAndZeroAreNeverAllowedRecipients() public view returns (bool) {
        return !w.isRecipientAllowed(address(0)) && !w.isRecipientAllowed(address(w));
    }
}
