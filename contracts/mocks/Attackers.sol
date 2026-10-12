// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * Hostile contracts. Each one is aimed at ONE named defence in PersonalWallet, so a test that
 * passes says something specific rather than "nothing blew up".
 */

interface IPersonalWallet {
    function executeNative(uint256 id) external;
    function executeERC20(uint256 id) external;
    function executeERC721(uint256 id) external;
    function executeERC1155(uint256 id) external;
    function executeNFTBatch(uint256 id) external;
    function executeOwnerReplacement(uint256 id) external;
    function acceptOwnerReplacement(uint256 id) external;
    function confirm(uint256 id) external;
    function proposeNative(address to, uint256 amount, uint64 ttl) external returns (uint256);
    function proposeOwnerReplacement(address oldOwner, address newOwner) external returns (uint256);
}

/**
 * @title ReentrancyAttacker
 * @notice Target: the `nonReentrant` guard plus the executed-before-interaction ordering.
 * @dev Modelled on the worst realistic case — the attacker IS one of the three owners (a seat was
 *      handed to a contract), because `execute*` is owner-only and a mere recipient could never
 *      re-enter it. On receiving native currency it immediately calls `executeNative` again on the
 *      same proposal, trying to drain the wallet twice on one approval.
 */
contract ReentrancyAttacker is IERC721Receiver, IERC1155Receiver {
    IPersonalWallet public wallet;
    uint256 public targetId;
    uint256 public reentryAttempts;
    bool public lastReentryReverted;
    bool public armed;

    /// @notice Which execute path the NFT callbacks should try to re-enter.
    enum Mode { BATCH, SINGLE_721, SINGLE_1155 }

    Mode public mode;

    /// @notice When set, re-entry is attempted WITHOUT try/catch, so the guard's own revert
    ///         propagates out of the whole transaction instead of being swallowed here.
    bool public strict;

    receive() external payable {
        _tryReenter();
    }

    function setWallet(address w) external {
        wallet = IPersonalWallet(w);
    }

    function arm(uint256 id) external {
        targetId = id;
        armed = true;
        reentryAttempts = 0;
    }

    function armStrict(uint256 id) external {
        targetId = id;
        armed = true;
        strict = true;
        reentryAttempts = 0;
    }

    function armWithMode(uint256 id, Mode m) external {
        targetId = id;
        mode = m;
        armed = true;
        reentryAttempts = 0;
    }

    function callExecuteERC721(uint256 id) external {
        wallet.executeERC721(id);
    }

    function callExecuteERC1155(uint256 id) external {
        wallet.executeERC1155(id);
    }

    function _reenterPerMode() private {
        reentryAttempts += 1;
        if (mode == Mode.SINGLE_721) {
            try wallet.executeERC721(targetId) {
                lastReentryReverted = false;
            } catch {
                lastReentryReverted = true;
            }
        } else if (mode == Mode.SINGLE_1155) {
            try wallet.executeERC1155(targetId) {
                lastReentryReverted = false;
            } catch {
                lastReentryReverted = true;
            }
        } else {
            try wallet.executeNFTBatch(targetId) {
                lastReentryReverted = false;
            } catch {
                lastReentryReverted = true;
            }
        }
    }

    function disarm() external {
        armed = false;
    }

    /// @notice Pass-throughs so the attacker can act as an owner in the tests.
    function callAccept(uint256 id) external {
        wallet.acceptOwnerReplacement(id);
    }

    function callConfirm(uint256 id) external {
        wallet.confirm(id);
    }

    function callExecuteNative(uint256 id) external {
        wallet.executeNative(id);
    }

    function callExecuteNFTBatch(uint256 id) external {
        wallet.executeNFTBatch(id);
    }

    function _tryReenter() private {
        if (!armed || address(wallet) == address(0)) return;
        reentryAttempts += 1;
        if (strict) {
            wallet.executeNative(targetId); // deliberately unguarded — let it blow up outward
            return;
        }
        // try/catch, not a bare call: the point is to observe that the re-entry is REFUSED while
        // letting the outer transaction continue, so the test can inspect both outcomes.
        try wallet.executeNative(targetId) {
            lastReentryReverted = false;
        } catch {
            lastReentryReverted = true;
        }
    }

    // NFT callbacks re-enter too — a batch transfer calls back once per item.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (armed) _reenterPerMode();
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (armed) _reenterPerMode();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure override returns (bool) {
        return id == type(IERC721Receiver).interfaceId || id == type(IERC1155Receiver).interfaceId
            || id == type(IERC165).interfaceId;
    }
}

/**
 * @title RejectingReceiver
 * @notice Target: `NativeTransferFailed`, and the proof that a failed send does not burn the
 *         proposal. Refuses every incoming native transfer.
 */
contract RejectingReceiver {
    bool public accepting;

    function setAccepting(bool v) external {
        accepting = v;
    }

    receive() external payable {
        require(accepting, "RejectingReceiver: no");
    }

    function sweep(address to) external {
        (bool ok,) = payable(to).call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}

/**
 * @title GasGriefingReceiver
 * @notice Target: the decision to forward all gas on native sends.
 * @dev Burns gas in an unbounded loop. The outer transaction must fail outright — which is the
 *      honest outcome — rather than appearing to succeed with the funds never delivered.
 */
contract GasGriefingReceiver {
    uint256 public sink;

    receive() external payable {
        while (true) {
            sink += 1;
        }
    }
}

/**
 * @title LyingERC20
 * @notice Target: SafeERC20's return-value check. `transfer` returns FALSE without reverting —
 *         the silent-failure class that lets a naive wallet emit a success event for a transfer
 *         that never happened.
 */
contract LyingERC20 {
    string public constant name = "Lying Token";
    string public constant symbol = "LIE";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    /// @dev Reports failure. Does not move anything. Does not revert.
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

/**
 * @title BlackHoleERC20
 * @notice Target: the `received == 0` guard in `depositERC20`. Reports success and moves nothing
 *         — a token that would otherwise let the wallet emit a deposit event for a deposit that
 *         never arrived. A realistic fee-charging token cannot take 100 % (Tether's own
 *         `setParams` caps the rate), but a malicious one can.
 */
contract BlackHoleERC20 {
    string public constant name = "Black Hole";
    string public constant symbol = "HOLE";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    /// @dev Debits the sender, credits nobody, and claims success.
    function transferFrom(address from, address, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/**
 * @title ReenteringERC20
 * @notice Target: `nonReentrant` on the ERC-20 path. A token with a transfer hook that calls back
 *         into the wallet — the ERC-777 / callback-token class of attack.
 */
contract ReenteringERC20 {
    string public constant name = "Reentering Token";
    string public constant symbol = "REENT";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    IPersonalWallet public wallet;
    uint256 public targetId;
    uint256 public reentryAttempts;
    bool public lastReentryReverted;
    /// @notice When set, the hook re-enters WITHOUT try/catch. SafeERC20 bubbles the revert data
    ///         up unchanged, so the guard's own error reaches the original caller — unlike the
    ///         native path, where a low-level `call` swallows it.
    bool public strict;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function arm(address w, uint256 id) external {
        wallet = IPersonalWallet(w);
        targetId = id;
    }

    function armStrict(address w, uint256 id) external {
        wallet = IPersonalWallet(w);
        targetId = id;
        strict = true;
    }

    /// @dev The modifier order on the wallet is `onlyOwners nonReentrant executable(...)`, so a
    ///      token that is NOT an owner is stopped by NotOwner and never reaches the reentrancy
    ///      guard at all. To observe the guard's own error, the token has to hold a seat —
    ///      absurd in practice, which is the point: the guard sits behind onlyOwners.
    function setWallet(address w) external {
        wallet = IPersonalWallet(w);
    }

    function callAccept(uint256 id) external {
        wallet.acceptOwnerReplacement(id);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        if (address(wallet) != address(0)) {
            reentryAttempts += 1;
            if (strict) {
                wallet.executeERC20(targetId); // unguarded on purpose — let it blow up outward
            } else {
                try wallet.executeERC20(targetId) {
                    lastReentryReverted = false;
                } catch {
                    lastReentryReverted = true;
                }
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }
}

/**
 * @title BadERC721Receiver
 * @notice Target: the use of `safeTransferFrom` for NFTs. Returns the wrong magic value, so a
 *         standards-compliant collection must refuse to deliver the token. Proves the wallet
 *         cannot send an NFT into a contract that would strand it.
 */
contract BadERC721Receiver is IERC165 {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xdeadbeef;
    }

    function supportsInterface(bytes4) external pure override returns (bool) {
        return true;
    }
}

/**
 * @title OutsiderProber
 * @notice Target: `onlyOwners` on every state-changing entry point. A contract that is not an
 *         owner and tries everything. Every call must revert with NotOwner.
 */
contract OutsiderProber {
    function tryPropose(address w, address to) external returns (uint256) {
        return IPersonalWallet(w).proposeNative(to, 1, 3600);
    }

    function tryConfirm(address w, uint256 id) external {
        IPersonalWallet(w).confirm(id);
    }

    function tryExecuteNative(address w, uint256 id) external {
        IPersonalWallet(w).executeNative(id);
    }

    function tryExecuteOwnerReplacement(address w, uint256 id) external {
        IPersonalWallet(w).executeOwnerReplacement(id);
    }

    function tryReplaceOwner(address w, address oldO, address newO) external returns (uint256) {
        return IPersonalWallet(w).proposeOwnerReplacement(oldO, newO);
    }

    receive() external payable {}
}

/**
 * @title SelfDestructPusher
 * @notice Target: the accounting assumption that native balance only arrives through `receive()`
 *         or `fallback()`. A forced send via SELFDESTRUCT credits the balance with NO event.
 * @dev This is not a vulnerability — the wallet reads `address(this).balance`, so forced funds are
 *      spendable — but it IS the reason the wallet must never track its own balance in a variable.
 *      The test asserts the forced ether is spendable.
 */
contract SelfDestructPusher {
    /// @dev `selfdestruct` is deprecated and EIP-6780 (Cancun) no longer deletes the account —
    ///      but it still TRANSFERS the balance, which is the only part this probe needs.
    function push(address payable target) external payable {
        selfdestruct(target);
    }
}
