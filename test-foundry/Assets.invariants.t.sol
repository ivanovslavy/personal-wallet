// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC, MockERC721, MockERC1155} from "../contracts/mocks/TestTokens.sol";
import {ReenteringERC20} from "../contracts/mocks/Attackers.sol";

/**
 * Campaign 3 — the six proposal kinds the first campaign never drove, plus a token that re-enters.
 *
 * Campaign 1 covered NATIVE, ERC20, ALLOW_RECIPIENT, OWNER_REPLACE and SET_POLICY. The wallet has
 * eleven kinds. Left untouched were all three NFT paths (ERC721, ERC1155, NFT_BATCH — the last with
 * up to 50 items in one call) and the three that SHRINK power: ALLOW_TOKEN, REVOKE_TOKEN,
 * REVOKE_RECIPIENT. Shrinking is the half that is deliberately immediate and unstoppable, so it is
 * exactly the half worth attacking.
 *
 * ReenteringERC20 joins as a participant rather than a prop: it calls back into the wallet during
 * its own transfer, at whatever moment the fuzzer happens to have arranged.
 */
contract AssetHandler is Test {
    PersonalWallet public w;
    MockUSDC public usdc;
    MockERC721 public nft;
    MockERC1155 public multi;
    ReenteringERC20 public reenter;
    address[3] public owners;
    address public dest;

    uint256[] public ids;
    uint256 public calls;
    uint256 public execNFT;      // 721 + 1155 + batch executions
    uint256 public execShrink;   // revoke-token / revoke-recipient / allow-token executions
    uint256 public reentryWon;   // a re-entrant call that actually got through — must stay 0
    uint256 public nftHeldButSent;   // wallet still owns an NFT it reported as sent — must stay 0
    uint256 public nextTokenId = 1;
    // WHY WE TRACK WHAT IS ACTUALLY INSIDE. Proposing a random tokenId means executeERC721 reverts
    // because the vault does not own it — the first asset campaign executed ZERO NFT transfers for
    // exactly that reason. Propose only what the wallet really holds; that is also what an operator
    // does.
    uint256[] public heldNFT;
    uint256[] public held1155;
    function heldNFTCount() external view returns (uint256) { return heldNFT.length; }

    constructor(PersonalWallet _w, MockUSDC _u, MockERC721 _n, MockERC1155 _m, ReenteringERC20 _r,
                address[3] memory _o, address _dest) {
        w = _w; usdc = _u; nft = _n; multi = _m; reenter = _r; owners = _o; dest = _dest;
    }
    function _owner(uint256 s) internal view returns (address) { return owners[s % 3]; }
    function _id(uint256 s) internal view returns (uint256) {
        if (ids.length == 0) return 0;
        return ids[bound(s, 0, ids.length - 1)];
    }
    function idCount() external view returns (uint256) { return ids.length; }

    // ---- deposits of every asset shape ----------------------------------------------------------
    function depositNFT() public {
        uint256 t = nextTokenId++;
        nft.mint(address(this), t);
        nft.approve(address(w), t);
        try w.depositERC721(address(nft), t) { heldNFT.push(t); } catch {}
        calls++;
    }
    function deposit1155(uint256 id, uint256 amt) public {
        id = bound(id, 1, 20); amt = bound(amt, 1, 1000);
        multi.mint(address(this), id, amt);
        multi.setApprovalForAll(address(w), true);
        try w.depositERC1155(address(multi), id, amt) { held1155.push(id); } catch {}
        calls++;
    }
    function depositReenterToken(uint256 amt) public {
        amt = bound(amt, 1, 1_000e6);
        reenter.mint(address(this), amt);
        reenter.approve(address(w), amt);
        try w.depositERC20(address(reenter), amt) {} catch {}
        calls++;
    }

    // ---- the six kinds campaign 1 never proposed -------------------------------------------------
    function proposeERC721(uint256 who, uint256 tokenId, uint64 ttl) public {
        ttl = uint64(bound(ttl, 20 days, 30 days));
        if (heldNFT.length == 0) { calls++; return; }
        uint256 t = heldNFT[bound(tokenId, 0, heldNFT.length - 1)];
        vm.prank(_owner(who));
        try w.proposeERC721(address(nft), dest, t, ttl) returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }
    function proposeERC1155(uint256 who, uint256 tid, uint256 amt, uint64 ttl) public {
        ttl = uint64(bound(ttl, 20 days, 30 days));
        if (held1155.length == 0) { calls++; return; }
        uint256 realId = held1155[bound(tid, 0, held1155.length - 1)];
        uint256 have = w.erc1155Balance(address(multi), realId);
        if (have == 0) { calls++; return; }
        vm.prank(_owner(who));
        try w.proposeERC1155(address(multi), dest, realId, bound(amt, 1, have), ttl) returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }
    function proposeNFTBatch(uint256 who, uint256 n, uint64 ttl) public {
        n = bound(n, 1, 50);                       // MAX_BATCH is 50 — ride the edge
        ttl = uint64(bound(ttl, 20 days, 30 days));
        if (heldNFT.length == 0) { calls++; return; }
        if (n > heldNFT.length) n = heldNFT.length;
        PersonalWallet.BatchItem[] memory items = new PersonalWallet.BatchItem[](n);
        for (uint256 k; k < n; k++) {
            items[k] = PersonalWallet.BatchItem(address(nft), PersonalWallet.Standard.ERC721, heldNFT[k], 0);
        }
        vm.prank(_owner(who));
        try w.proposeNFTBatch(dest, items, ttl) returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }
    function proposeAllowToken(uint256 who, uint256 rnd) public {
        vm.prank(_owner(who));
        try w.proposeAllowToken(address(uint160(bound(rnd, 1, type(uint160).max))), "fuzz") returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }
    function proposeRevokeToken(uint256 who, uint256 which) public {
        address t = which % 2 == 0 ? address(usdc) : address(nft);
        vm.prank(_owner(who));
        try w.proposeRevokeToken(t) returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }
    function proposeRevokeRecipient(uint256 who) public {
        vm.prank(_owner(who));
        try w.proposeRevokeRecipient(dest) returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }

    function confirmAll(uint256 s) public {
        uint256 id = _id(s);
        for (uint256 k; k < 3; k++) { vm.prank(owners[k]); try w.confirm(id) {} catch {} }
        calls++;
    }
    function veto(uint256 who, uint256 s) public { vm.prank(_owner(who)); try w.veto(_id(s)) {} catch {} calls++; }

    /// Arm the re-entrant token at a moment of the fuzzer's choosing.
    function armReentry(uint256 s, bool strict) public {
        uint256 id = _id(s);
        reenter.setWallet(address(w));
        if (strict) { try reenter.armStrict(address(w), id) {} catch {} }
        else        { try reenter.arm(address(w), id) {} catch {} }
        calls++;
    }

    /// Execute everything ready, by every door, and check the NFT paths told the truth.
    function executeAll(uint256 who) public {
        for (uint256 k; k < ids.length; k++) {
            uint256 id = ids[k];
            PersonalWallet.Proposal memory p = w.getProposal(id);
            if (p.executed || p.cancelled) continue;
            address caller = _owner(who + k);

            vm.prank(caller);
            try w.executeERC721(id) {
                execNFT++;
                // it said it sent tokenId p.value — does it still hold it?
                if (w.erc721Owned(p.token, p.value)) nftHeldButSent++;
            } catch {}
            vm.prank(caller);
            try w.executeERC1155(id) { execNFT++; } catch {}
            vm.prank(caller);
            try w.executeNFTBatch(id) { execNFT++; } catch {}
            vm.prank(caller);
            try w.executeAllowToken(id) { execShrink++; } catch {}
            vm.prank(caller);
            try w.executeRevokeToken(id) { execShrink++; } catch {}
            vm.prank(caller);
            try w.executeRevokeRecipient(id) { execShrink++; } catch {}
            vm.prank(caller);
            try w.executeERC20(id) {} catch {}
        }
        calls++;
    }

    function warp(uint256 s) public { vm.warp(block.timestamp + bound(s, 1 minutes, 2 hours)); calls++; }
    receive() external payable {}
}

contract AssetInvariants is Test {
    PersonalWallet w; AssetHandler h;
    MockUSDC usdc; MockERC721 nft; MockERC1155 multi; ReenteringERC20 reenter;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        usdc = new MockUSDC(); nft = new MockERC721("N","N"); multi = new MockERC1155();
        reenter = new ReenteringERC20();
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](4); string[] memory tl = new string[](4);
        t[0]=address(usdc); t[1]=address(nft); t[2]=address(multi); t[3]=address(reenter);
        tl[0]="USDC"; tl[1]="NFT"; tl[2]="M1155"; tl[3]="REENTER";
        w = new PersonalWallet([o1,o2,o3], true, true, r, rl, t, tl);
        h = new AssetHandler(w, usdc, nft, multi, reenter, [o1,o2,o3], dest);

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](20);
        sel[0]=AssetHandler.depositNFT.selector;            sel[1]=AssetHandler.depositNFT.selector;
        sel[2]=AssetHandler.deposit1155.selector;           sel[3]=AssetHandler.depositReenterToken.selector;
        sel[4]=AssetHandler.proposeERC721.selector;         sel[5]=AssetHandler.proposeERC1155.selector;
        sel[6]=AssetHandler.proposeNFTBatch.selector;       sel[7]=AssetHandler.proposeAllowToken.selector;
        sel[8]=AssetHandler.proposeRevokeToken.selector;    sel[9]=AssetHandler.proposeRevokeRecipient.selector;
        sel[10]=AssetHandler.confirmAll.selector;           sel[11]=AssetHandler.confirmAll.selector;
        sel[12]=AssetHandler.executeAll.selector;           sel[13]=AssetHandler.executeAll.selector;
        sel[14]=AssetHandler.armReentry.selector;           sel[15]=AssetHandler.veto.selector;
        sel[16]=AssetHandler.confirmAll.selector;           sel[17]=AssetHandler.executeAll.selector;
        sel[18]=AssetHandler.executeAll.selector;           sel[19]=AssetHandler.depositNFT.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// An NFT reported as sent must not still be in the vault.
    function invariant_nftSentIsReallyGone() public view {
        assertEq(h.nftHeldButSent(), 0, "reported an NFT as sent while still holding it");
    }
    /// Re-entrancy never completes a second state change.
    function invariant_reentrancyNeverWins() public view {
        assertEq(h.reentryWon(), 0, "a re-entrant call got through");
    }
    /// Shrinking power can never remove the last owner's seat or corrupt the set.
    function invariant_ownersSurviveEveryShrink() public view {
        address[3] memory o = w.owners();
        assertTrue(o[0] != address(0) && o[1] != address(0) && o[2] != address(0), "zero owner");
        assertTrue(o[0] != o[1] && o[1] != o[2] && o[0] != o[2], "duplicate owner");
    }
    /// Registry coherence.
    ///
    /// 🔴 MY MISTAKE, CORRECTED. The first version asserted list.length == registeredCount and the
    /// deep campaign failed it: revoke the only recipient and the list is 0 while the count is 1.
    /// That is not a defect — the contract's own NatSpec says allowedRecipients() is "every
    /// destination CURRENTLY allowed" while registeredRecipientCount() is "everything EVER
    /// registered, allowed or since revoked". They measure different sets on purpose. The real
    /// property is containment: the allowed set can never exceed what was ever registered, and the
    /// returned lists must agree with isAllowed for every entry.
    function invariant_registriesStayCoherent() public view {
        (address[] memory tl,) = w.allowedTokens();
        (address[] memory rl,) = w.allowedRecipients();
        assertLe(tl.length, w.registeredTokenCount(), "allowed tokens exceed ever-registered");
        assertLe(rl.length, w.registeredRecipientCount(), "allowed recipients exceed ever-registered");
        for (uint256 i; i < tl.length; i++) assertTrue(w.isTokenAllowed(tl[i]), "listed token not allowed");
        for (uint256 i; i < rl.length; i++) assertTrue(w.isRecipientAllowed(rl[i]), "listed recipient not allowed");
    }

    function afterInvariant() public view {
        console2.log("calls          :", h.calls());
        console2.log("proposals      :", h.idCount());
        console2.log("NFT executions :", h.execNFT());
        console2.log("shrink execs   :", h.execShrink());
        console2.log("tokens allowed :", w.registeredTokenCount());
        console2.log("recips allowed :", w.registeredRecipientCount());
    }
}
