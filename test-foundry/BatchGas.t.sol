// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockERC721} from "../contracts/mocks/TestTokens.sol";

/// MAX_BATCH is 50. Nobody had ever measured what fifty items actually COST. If an executeNFTBatch
/// cannot fit in a block, the proposal is stuck for good — confirmed, matured, and unexecutable.
contract BatchGas is Test {
    PersonalWallet w; MockERC721 nft;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        nft = new MockERC721("N","N");
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](1); string[] memory tl = new string[](1);
        t[0] = address(nft); tl[0] = "NFT";
        w = new PersonalWallet([o1,o2,o3], true, true, r, rl, t, tl);
    }

    function _run(uint256 n) internal returns (uint256 gProp, uint256 gExec) {
        PersonalWallet.BatchItem[] memory items = new PersonalWallet.BatchItem[](n);
        for (uint256 i; i < n; i++) {
            nft.mint(address(this), i + 1);
            nft.approve(address(w), i + 1);
            w.depositERC721(address(nft), i + 1);
            items[i] = PersonalWallet.BatchItem(address(nft), PersonalWallet.Standard.ERC721, i + 1, 0);
        }
        vm.prank(o1);
        uint256 g0 = gasleft();
        uint256 id = w.proposeNFTBatch(dest, items, 20 days);
        gProp = g0 - gasleft();
        vm.prank(o2); w.confirm(id);
        vm.prank(o1);
        g0 = gasleft();
        w.executeNFTBatch(id);
        gExec = g0 - gasleft();
    }

    function test_gasAcrossBatchSizes() public {
        uint256[4] memory sizes = [uint256(1), 10, 25, 50];
        for (uint256 k; k < 4; k++) {
            setUp();
            (uint256 gp, uint256 ge) = _run(sizes[k]);
            console2.log("items:", sizes[k]);
            console2.log("   propose gas :", gp);
            console2.log("   execute gas :", ge);
            console2.log("   total       :", gp + ge);
        }
    }
}
