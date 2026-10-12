// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * Test tokens that imitate the REAL stablecoins' awkward behaviour, not an idealised ERC-20.
 * A wallet that only ever sees a textbook token is not tested.
 */

/**
 * @title MockUSDT
 * @notice Tether's actual quirks: 6 decimals, `transfer`/`transferFrom` that return NOTHING, and
 *         an optional basis-point transfer fee.
 * @dev The missing return value is the whole reason SafeERC20 exists. A contract that does
 *      `require(token.transfer(...))` reverts against this token and the balance is stuck forever.
 *      Written from scratch rather than extending OZ's ERC20, because OZ's signatures return bool
 *      and that is exactly what must NOT be here.
 */
contract MockUSDT {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Transfer fee in basis points, as Tether has. 0 by default, like the live contract.
    uint256 public basisPointsRate;
    uint256 public maximumFee;
    address public feeCollector;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        feeCollector = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Turn the fee on, to prove the wallet survives a fee-on-transfer token.
    function setParams(uint256 newBasisPoints, uint256 newMaxFee) external {
        require(newBasisPoints < 20, "fee too high");
        basisPointsRate = newBasisPoints;
        maximumFee = newMaxFee;
    }

    // NOTE: no `returns (bool)`. Deliberate.
    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "USDT: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "USDT: balance");
        uint256 fee = (value * basisPointsRate) / 10000;
        if (fee > maximumFee) fee = maximumFee;
        uint256 net = value - fee;
        balanceOf[from] -= value;
        balanceOf[to] += net;
        if (fee > 0) {
            balanceOf[feeCollector] += fee;
            emit Transfer(from, feeCollector, fee);
        }
        emit Transfer(from, to, net);
    }
}

/**
 * @title MockUSDC
 * @notice 6 decimals and a blocklist, as Circle's USDC has. A blocked address makes the transfer
 *         revert — which must leave the proposal re-executable, not burnt.
 */
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;
    address public immutable admin;

    error Blocked(address account);

    constructor() ERC20("USD Coin", "USDC") {
        admin = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool value) external {
        require(msg.sender == admin, "USDC: not admin");
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}

/**
 * @title MockEURC
 * @notice 6 decimals and a global pause, as Circle's EURC has.
 */
contract MockEURC is ERC20 {
    bool public paused;
    address public immutable admin;

    error TokenPaused();

    constructor() ERC20("Euro Coin", "EURC") {
        admin = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool value) external {
        require(msg.sender == admin, "EURC: not admin");
        paused = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused) revert TokenPaused();
        super._update(from, to, value);
    }
}

/// @title MockERC721 — a plain, correct NFT collection.
contract MockERC721 is ERC721 {
    constructor(string memory n, string memory s) ERC721(n, s) {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    /// @dev `_safeMint` so the wallet's IERC721Receiver hook is exercised on the way in, too.
    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}

/// @title MockERC1155 — a plain, correct multi-token collection.
contract MockERC1155 is ERC1155 {
    constructor() ERC1155("ipfs://mock/{id}.json") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        _mintBatch(to, ids, amounts, "");
    }
}
