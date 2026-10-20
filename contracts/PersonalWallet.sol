// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PersonalWallet
 * @notice A savings wallet held by EXACTLY THREE owners. Every operation that can move value
 *  needs two of them; adding a new destination needs all three AND a timelock.
 *  Holds native currency, ERC-20, ERC-721 and ERC-1155.
 *
 * @dev THE DESIGN, AND WHY EACH PIECE IS THE WAY IT IS.
 *
 * NOT A PROXY, and not upgradeable. The address you fund is the code you audited; there is no
 * admin slot, no implementation pointer and no delegatecall anywhere. The price is that a bug
 * cannot be patched in place — which is why the logic is small, typed, and has no generic
 * "execute arbitrary calldata" path.
 *
 * NO Ownable, therefore no renounceOwnership. OpenZeppelin's Ownable carries a live
 * `renounceOwnership()` that sets the owner to address(0); on a contract holding funds that is
 * one transaction from locking everything forever. No code path here can reduce the owner set
 * below three.
 *
 * CONFIRMATIONS ARE COUNTED AT EXECUTION, NOT ACCUMULATED. A counter-based multisig lets a
 * replaced owner's stale approval still count. `_confirmations()` walks the CURRENT owner set
 * every time, so rotating an owner instantly invalidates their pending votes.
 *
 * ── THE THREAT THIS VERSION ADDRESSES: TWO COMPROMISED KEYS ───────────────────────────────
 *
 * With 2-of-3, an attacker holding two keys can do anything two owners can. No control that
 * two owners can switch off is worth anything against that. So the design rests on one rule:
 *
 *  EXPANDING what the wallet can do is SLOW and ANY ONE OWNER can stop it.
 *  SHRINKING what the wallet can do is IMMEDIATE and nobody can stop it.
 *
 * Expanding (timelocked + vetoable by a single owner):
 *  · adding a recipient to the allowlist — and this one needs ALL THREE owners
 *  · replacing an owner
 *  · loosening the policy: shortening the delay, or switching a requirement off
 *
 * Shrinking (two owners, immediate, not vetoable):
 *  · removing a recipient · adding or removing a token · switching a requirement on
 *  · lengthening the delay
 *
 * Why owner replacement MUST be timelocked too: without it, two compromised keys simply replace
 * the third, honest owner with their own address, hold all three seats, and then there is nobody
 * left to veto anything. The recipient timelock would be theatre.
 *
 * Why a single owner must be able to veto: if a veto needed two owners, the two attackers would
 * refuse and the veto would be useless. The cost is that one hostile owner can block new
 * recipients and block their own removal. That is griefing, and griefing is strictly better than
 * theft — with 2-of-3 on transfers the honest pair can still move everything out to an
 * already-allowlisted address.
 *
 *  OPERATING RULE THAT FOLLOWS: always keep at least one allowlisted recipient that is a cold
 *  address you control. It is the escape hatch. Without it the survivable case stops being
 *  survivable.
 *
 * Why adding a TOKEN is not timelocked: it grants no ability to steal, because the recipient
 * allowlist still binds. An attacker may allowlist any token they like and still have nowhere
 * to send it.
 *
 * Why the delay has both a floor and a CEILING: the floor (MIN_DELAY) means the control can
 * never be dismantled down to nothing. The ceiling (MAX_DELAY) is the less obvious one —
 * because *lengthening* the delay is immediate by design, without a cap a hostile owner could
 * set it to a century and permanently prevent any new recipient from ever being added.
 */
contract PersonalWallet is ERC721Holder, ERC1155Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// @notice The owner set is fixed in size. Nothing can grow or shrink it.
    uint256 public constant OWNER_COUNT = 3;
    /// @notice Approvals required for an ordinary operation.
    uint256 public constant THRESHOLD = 2;
    /// @notice Approvals required to allowlist a new recipient. All three, deliberately.
    uint256 public constant UNANIMOUS = 3;

    /// @notice Bounds on how long a VALUE-TRANSFER proposal may stay executable.
    uint64 public constant MIN_TTL = 10 minutes;
    uint64 public constant MAX_TTL = 30 days;

    /// @notice Upper bound on a batch, so one proposal can never be too large to execute.
    uint256 public constant MAX_BATCH = 50;

    /// @notice Bounds on the timelock. The floor can never be lowered, the ceiling never raised.
    uint64 public constant MIN_DELAY = 24 hours;
    uint64 public constant MAX_DELAY = 30 days;
    /// @notice What `delay` starts at. 72 h rather than 48 h so a Friday-night move is still
    ///  vetoable on Monday morning.
    uint64 public constant DEFAULT_DELAY = 72 hours;

    /// @notice How long a governance proposal stays executable once it matures. Governance
    ///  proposals take no ttl from the caller — the timelock dictates their schedule, and
    ///  letting a caller pick a lifetime shorter than the delay would create proposals
    ///  that can never execute.
    uint64 public constant EXECUTION_WINDOW = 7 days;

    // ---------------------------------------------------------------- types

    enum Kind {
        NATIVE, // move native currency
        ERC20, // move an ERC-20
        ERC721, // move one ERC-721 token
        ERC1155, // move one ERC-1155 id
        NFT_BATCH, // move many NFTs of either standard in one go
        OWNER_REPLACE, // swap one owner for another          — timelocked, vetoable
        ALLOW_TOKEN, // allowlist a token contract
        REVOKE_TOKEN, // remove a token from the allowlist
        ALLOW_RECIPIENT, // allowlist a destination           — 3-of-3, timelocked, vetoable
        REVOKE_RECIPIENT, // remove a destination
        SET_POLICY // change the delay and/or the two requirement flags
    }

    enum Standard {
        ERC721,
        ERC1155
    }

    struct BatchItem {
        address token;
        Standard standard;
        uint256 id;
        uint256 amount; // ignored for ERC-721; must be > 0 for ERC-1155
    }

    struct Proposal {
        Kind kind;
        address token; // asset contract, or the token being allowlisted
        address to; // recipient, the incoming owner, or the address being allowlisted
        address subject; // the outgoing owner for OWNER_REPLACE; unused otherwise
        uint256 value; // amount, or tokenId for ERC-721, or the new delay for SET_POLICY
        uint256 amount; // ERC-1155 quantity, or the packed flags for SET_POLICY
        uint64 expiresAt;
        bool executed;
        bool cancelled;
        bool accepted; // OWNER_REPLACE only: the incoming owner has accepted
        address proposer;
    }

    /// @dev One shape for both registries. The label is supplied BY AN OWNER and never read from
    ///  the token: calling `name()` on an untrusted contract is an external call into hostile
    ///  code, and a scam token will happily call itself "USDT".
    struct Entry {
        string label;
        bool allowed;
        uint64 addedAt;
    }

    // ---------------------------------------------------------------- storage

    address[OWNER_COUNT] private _owners;
    mapping(address => bool) public isOwner;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasConfirmed;
    mapping(uint256 => BatchItem[]) private _batches;

    /**
     * @dev The timelock lives in its own mapping, NOT as a field of Proposal. Two reasons:
     *  a new struct field would spill the hot slot and add ~20 000 gas to EVERY `propose*`
     *  including plain transfers; and `_effectiveAt[id] != 0` is then the single, honest
     *  definition of "this proposal is timelocked and therefore vetoable".
     */
    mapping(uint256 => uint64) private _effectiveAt;
    /// @dev Labels likewise: only governance proposals carry one, so transfers pay nothing.
    mapping(uint256 => string) private _label;

    uint64 public delay;
    bool public requireAllowedRecipient;
    bool public requireAllowedToken;

    mapping(address => Entry) private _tokens;
    mapping(address => Entry) private _recipients;
    address[] private _tokenList;
    address[] private _recipientList;

    // ---------------------------------------------------------------- events

    event Deposited(address indexed from, uint256 amount, bool viaFallback);
    event DepositedERC20(address indexed token, address indexed from, uint256 amount);
    event DepositedERC721(address indexed token, address indexed from, uint256 tokenId);
    event DepositedERC1155(address indexed token, address indexed from, uint256 id, uint256 amount);
    event DepositedNFTBatch(address indexed from, uint256 itemCount);

    event Proposed(uint256 indexed id, Kind kind, address indexed proposer, uint64 expiresAt);
    event Scheduled(uint256 indexed id, uint64 effectiveAt, uint64 appliedDelay);
    event Confirmed(uint256 indexed id, address indexed owner, uint256 confirmations);
    event ConfirmationRevoked(uint256 indexed id, address indexed owner, uint256 confirmations);
    event Cancelled(uint256 indexed id, address indexed by);
    event Vetoed(uint256 indexed id, address indexed by);
    event Executed(uint256 indexed id, Kind kind, address indexed executor);

    event NativeSent(uint256 indexed id, address indexed to, uint256 amount);
    event ERC20Sent(uint256 indexed id, address indexed token, address indexed to, uint256 amount);
    event ERC721Sent(uint256 indexed id, address indexed token, address indexed to, uint256 tokenId);
    event ERC1155Sent(uint256 indexed id, address indexed token, address indexed to, uint256 tokenId, uint256 amount
    );
    event NFTBatchSent(uint256 indexed id, address indexed to, uint256 itemCount);

    event OwnerReplacementAccepted(uint256 indexed id, address indexed newOwner);
    event OwnerReplaced(uint256 indexed id, address indexed oldOwner, address indexed newOwner);

    event TokenAllowed(address indexed token, string label);
    event TokenRevoked(address indexed token);
    event RecipientAllowed(address indexed recipient, string label);
    event RecipientRevoked(address indexed recipient);
    event PolicyChanged(uint64 delay, bool requireAllowedRecipient, bool requireAllowedToken);

    // ---------------------------------------------------------------- errors

    error NotOwner(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error DuplicateOwner(address owner);
    error SelfRecipient();
    error BadTtl(uint64 ttl);
    error BadDelay(uint64 delay);
    error NoSuchProposal(uint256 id);
    error WrongKind(uint256 id);
    error AlreadyExecuted(uint256 id);
    error ProposalCancelled(uint256 id);
    error Expired(uint256 id);
    error AlreadyConfirmed(uint256 id, address owner);
    error NotConfirmed(uint256 id, address owner);
    error NotEnoughConfirmations(uint256 id, uint256 have, uint256 need);
    error NotProposer(uint256 id);
    error ConfirmationsLocked(uint256 id);
    error NotIncomingOwner(uint256 id, address caller);
    error NotAccepted(uint256 id);
    error AlreadyAccepted(uint256 id);
    error SubjectNotOwner(address subject);
    error InsufficientBalance(uint256 have, uint256 want);
    error NativeTransferFailed(address to, uint256 amount);
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error TimelockNotElapsed(uint256 id, uint64 effectiveAt);
    error NotTimelocked(uint256 id);
    error TokenNotAllowed(address token);
    error RecipientNotAllowed(address recipient);
    error AlreadyAllowed(address account);
    error NotAllowed(address account);
    error LengthMismatch();
    error NoPolicyChange();

    // ---------------------------------------------------------------- modifiers

    modifier onlyOwners() {
        if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
        _;
    }

    /**
     * @dev Shared guard for every execute path: exists, right kind, live, matured, and approved
     *  by enough of the CURRENT owners for that kind.
     */
    modifier executable(uint256 id, Kind kind) {
        Proposal storage p = _mustExist(id);
        if (p.kind != kind) revert WrongKind(id);
        if (p.executed) revert AlreadyExecuted(id);
        if (p.cancelled) revert ProposalCancelled(id);
        if (block.timestamp > p.expiresAt) revert Expired(id);
        uint64 eff = _effectiveAt[id];
        if (eff != 0 && block.timestamp < eff) revert TimelockNotElapsed(id, eff);
        uint256 need = _requiredFor(kind);
        uint256 have = _confirmations(id);
        if (have < need) revert NotEnoughConfirmations(id, have, need);
        _;
    }

    // ---------------------------------------------------------------- construction

    /**
     * @param initialOwners The three owners. Distinct, non-zero, and not this contract.
     * @param reqRecipient Enforce the recipient allowlist from the first block.
     * @param reqToken Enforce the token allowlist from the first block.
     * @param recipients Addresses seeded into the recipient allowlist, active immediately.
     * @param recipientLabels Labels for those, same length.
     * @param tokens Token contracts seeded into the token allowlist.
     * @param tokenLabels Labels for those, same length.
     *
     * @dev The seeds skip the timelock on purpose: at construction there is no attacker and no
     *  owner set to protect from — whoever deploys defines the initial trust. Seeding is also
     *  what makes the escape hatch possible from block one; with `reqRecipient = true` and an
     *  empty list the wallet could not send anything until a 3-of-3 plus 72 h had completed.
     */
    constructor(address[OWNER_COUNT] memory initialOwners,
        bool reqRecipient,
        bool reqToken,
        address[] memory recipients,
        string[] memory recipientLabels,
        address[] memory tokens,
        string[] memory tokenLabels
    ) {
        for (uint256 i; i < OWNER_COUNT; ++i) {
            address o = initialOwners[i];
            if (o == address(0)) revert ZeroAddress();
            if (o == address(this)) revert SelfRecipient();
            if (isOwner[o]) revert DuplicateOwner(o);
            isOwner[o] = true;
            _owners[i] = o;
        }

        delay = DEFAULT_DELAY;
        requireAllowedRecipient = reqRecipient;
        requireAllowedToken = reqToken;
        emit PolicyChanged(DEFAULT_DELAY, reqRecipient, reqToken);

        if (recipients.length != recipientLabels.length) revert LengthMismatch();
        if (tokens.length != tokenLabels.length) revert LengthMismatch();
        for (uint256 i; i < recipients.length; ++i) {
            _allowRecipient(recipients[i], recipientLabels[i]);
        }
        for (uint256 i; i < tokens.length; ++i) {
            _allowToken(tokens[i], tokenLabels[i]);
        }
    }

    // ---------------------------------------------------------------- funding

    /// @notice Plain native transfers.
    receive() external payable {
        emit Deposited(msg.sender, msg.value, false);
    }

    /**
     * @notice Native transfers that carry calldata.
     * @dev A wallet with only `receive()` reverts when a sender attaches data — some relayers,
     *  bridges and contract-to-contract sends do. No calldata is interpreted here.
     */
    fallback() external payable {
        emit Deposited(msg.sender, msg.value, true);
    }

    /**
     * ── DEPOSIT FUNCTIONS ──────────────────────────────────────────────────────────────────
     *
     * Deliberately SINGLE-SIGNATURE, and callable by anyone. Multisig exists to stop value
     * LEAVING against the owners' will; a deposit increases the wallet's assets, so a 2-of-3
     * gate on it would protect nothing while costing three transactions per deposit and adding a
     * failure mode that does not exist today — a legitimate delivery being refused.
     *
     * What these buy over a plain `token.transfer(wallet, x)`: an event naming WHO deposited,
     * which a raw transfer can never give, and a clean accounted path.
     *
     * What they do NOT buy: exclusivity. An ERC-20 can always be pushed to any address, because
     * ERC-20 has no receive hook and this contract's code does not run during such a transfer.
     * These are an additional path, never the only one.
     */

    /// @notice Deposit native currency with an explicit call.
    function depositNative() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value, false);
    }

    /**
     * @notice Deposit an ERC-20. The depositor must `approve` this contract first.
     * @dev The event reports the amount ACTUALLY RECEIVED, measured from the balance, not the
     *  amount requested. With a fee-on-transfer token — USDT has the knobs for it, and plenty
     *  of others charge — those two numbers differ, and an event that reported the request
     *  would misstate the balance change. Since honest accounting is the only reason this
     *  function exists over a plain `transfer`, it has to be the received figure.
     */
    function depositERC20(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _requireAllowedToken(token);
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        emit DepositedERC20(token, msg.sender, received);
    }

    /// @notice Deposit one ERC-721 token.
    function depositERC721(address token, uint256 tokenId) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        _requireAllowedToken(token);
        IERC721(token).safeTransferFrom(msg.sender, address(this), tokenId);
        emit DepositedERC721(token, msg.sender, tokenId);
    }

    /// @notice Deposit a quantity of one ERC-1155 id.
    function depositERC1155(address token, uint256 id, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _requireAllowedToken(token);
        IERC1155(token).safeTransferFrom(msg.sender, address(this), id, amount, "");
        emit DepositedERC1155(token, msg.sender, id, amount);
    }

    /// @notice Deposit many NFTs of either standard, across collections, in one transaction.
    function depositNFTBatch(BatchItem[] calldata items) external nonReentrant {
        uint256 n = items.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n);
        for (uint256 i; i < n; ++i) {
            BatchItem calldata it = items[i];
            if (it.token == address(0)) revert ZeroAddress();
            _requireAllowedToken(it.token);
            if (it.standard == Standard.ERC721) {
                IERC721(it.token).safeTransferFrom(msg.sender, address(this), it.id);
                emit DepositedERC721(it.token, msg.sender, it.id);
            } else {
                if (it.amount == 0) revert ZeroAmount();
                IERC1155(it.token).safeTransferFrom(msg.sender, address(this), it.id, it.amount, "");
                emit DepositedERC1155(it.token, msg.sender, it.id, it.amount);
            }
        }
        emit DepositedNFTBatch(msg.sender, n);
    }

    // ---------------------------------------------------------------- proposing a transfer

    /// @notice Propose moving native currency. Counts as the proposer's own confirmation.
    function proposeNative(address to, uint256 amount, uint64 ttl)
        external
        onlyOwners
        returns (uint256 id)
    {
        _requireRecipient(to);
        if (amount == 0) revert ZeroAmount();
        id = _create(Kind.NATIVE, address(0), to, address(0), amount, 0, _transferExpiry(ttl));
    }

    /// @notice Propose moving an ERC-20 balance.
    function proposeERC20(address token, address to, uint256 amount, uint64 ttl)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        _requireAllowedToken(token);
        _requireRecipient(to);
        if (amount == 0) revert ZeroAmount();
        id = _create(Kind.ERC20, token, to, address(0), amount, 0, _transferExpiry(ttl));
    }

    /// @notice Propose moving a single ERC-721 token.
    function proposeERC721(address token, address to, uint256 tokenId, uint64 ttl)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        _requireAllowedToken(token);
        _requireRecipient(to);
        id = _create(Kind.ERC721, token, to, address(0), tokenId, 0, _transferExpiry(ttl));
    }

    /// @notice Propose moving a quantity of one ERC-1155 id.
    function proposeERC1155(address token, address to, uint256 tokenId, uint256 amount, uint64 ttl)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        _requireAllowedToken(token);
        _requireRecipient(to);
        if (amount == 0) revert ZeroAmount();
        id = _create(Kind.ERC1155, token, to, address(0), tokenId, amount, _transferExpiry(ttl));
    }

    /**
     * @notice Propose moving many NFTs — either standard, across collections — to one recipient.
     * @dev The items are stored with the proposal, so what the second owner approves is exactly
     *  what executes; nothing is passed again at execution time.
     */
    function proposeNFTBatch(address to, BatchItem[] calldata items, uint64 ttl)
        external
        onlyOwners
        returns (uint256 id)
    {
        _requireRecipient(to);
        uint256 n = items.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n);

        id = _create(Kind.NFT_BATCH, address(0), to, address(0), 0, 0, _transferExpiry(ttl));

        for (uint256 i; i < n; ++i) {
            BatchItem calldata it = items[i];
            if (it.token == address(0)) revert ZeroAddress();
            _requireAllowedToken(it.token);
            if (it.standard == Standard.ERC1155 && it.amount == 0) revert ZeroAmount();
            // Written straight into the mapping rather than through a `BatchItem[] storage`
            // pointer. Both compile to the same behaviour, but Slither's dataflow does not see a
            // push through a storage pointer as a write and reports `_batches` as an
            // uninitialized state variable — a HIGH finding on a savings vault, for nothing.
            // Measured cost of writing it this way: +2 974 gas on a full 50-item proposal
            // (3 590 096  3 593 070, +0.08 %), and 5 bytes less bytecode. Worth a clean report.
            _batches[id].push(it);
        }
    }

    // ---------------------------------------------------------------- proposing governance

    /**
     * @notice Propose swapping one owner for another.
     * @dev TIMELOCKED and VETOABLE, and it takes no ttl — the timelock sets the schedule.
     *  Without the timelock, two compromised keys would replace the honest owner instantly
     *  and every other control in this contract would stop working.
     *  Still needs the incoming owner to accept from their own address, so a typo costs
     *  nothing: the proposal simply expires.
     */
    function proposeOwnerReplacement(address oldOwner, address newOwner)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (!isOwner[oldOwner]) revert SubjectNotOwner(oldOwner);
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == address(this)) revert SelfRecipient();
        // NOTE: `oldOwner == newOwner` needs no separate check — oldOwner passed isOwner above,
        // so this line catches it. A dedicated branch would be unreachable code.
        if (isOwner[newOwner]) revert DuplicateOwner(newOwner);

        id = _createGovernance(Kind.OWNER_REPLACE, address(0), newOwner, oldOwner, 0, 0, "", true);
    }

    /**
     * @notice Propose allowlisting a destination address.
     * @dev ALL THREE owners, plus the timelock, plus any single owner can veto. This is the one
     *  place unanimity is right: it cannot freeze the wallet (transfers to existing
     *  recipients still work on 2-of-3, and recipients can still be removed and owners
     *  rotated), while making it maximally hard to widen the wallet's reach.
     */
    function proposeAllowRecipient(address recipient, string calldata label)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert SelfRecipient();
        if (_recipients[recipient].allowed) revert AlreadyAllowed(recipient);
        id = _createGovernance(Kind.ALLOW_RECIPIENT, address(0), recipient, address(0), 0, 0, label, true);
    }

    /// @notice Propose removing a destination. Two owners, immediate, not vetoable.
    function proposeRevokeRecipient(address recipient) external onlyOwners returns (uint256 id) {
        if (!_recipients[recipient].allowed) revert NotAllowed(recipient);
        id = _createGovernance(Kind.REVOKE_RECIPIENT, address(0), recipient, address(0), 0, 0, "", false);
    }

    /**
     * @notice Propose allowlisting a token contract.
     * @dev NOT timelocked: allowlisting a token grants no ability to steal, because the recipient
     *  allowlist still binds. Its value is surface reduction — the wallet never makes an
     *  external call into a contract nobody vetted.
     * @param label Your own label. Never read from the token: `name()` on an untrusted contract
     *  is a call into hostile code, and a scam token will call itself "USDT".
     */
    function proposeAllowToken(address token, string calldata label)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(this)) revert SelfRecipient();
        if (_tokens[token].allowed) revert AlreadyAllowed(token);
        id = _createGovernance(Kind.ALLOW_TOKEN, token, address(0), address(0), 0, 0, label, false);
    }

    /// @notice Propose removing a token. Two owners, immediate, not vetoable.
    function proposeRevokeToken(address token) external onlyOwners returns (uint256 id) {
        if (!_tokens[token].allowed) revert NotAllowed(token);
        id = _createGovernance(Kind.REVOKE_TOKEN, token, address(0), address(0), 0, 0, "", false);
    }

    /**
     * @notice Propose a new delay and/or new requirement flags.
     * @dev Whether this is timelocked is decided HERE, by whether it loosens anything:
     *  shortening the delay, or switching a requirement off. Tightening — a longer delay or
     *  switching a requirement on — takes effect as soon as two owners agree.
     *  Without that asymmetry an attacker would simply set the delay to the minimum, or turn
     *  the allowlist off, and proceed.
     */
    function proposeSetPolicy(uint64 newDelay, bool reqRecipient, bool reqToken)
        external
        onlyOwners
        returns (uint256 id)
    {
        if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) revert BadDelay(newDelay);
        if (newDelay == delay && reqRecipient == requireAllowedRecipient && reqToken == requireAllowedToken) {
            revert NoPolicyChange();
        }
        bool loosens = newDelay < delay || (requireAllowedRecipient && !reqRecipient)
            || (requireAllowedToken && !reqToken);

        uint256 flags = (reqRecipient ? 1 : 0) | (reqToken ? 2 : 0);
        id = _createGovernance(Kind.SET_POLICY, address(0), address(0), address(0), newDelay, flags, "", loosens);
    }

    // ---------------------------------------------------------------- voting

    /// @notice Add your approval to a live proposal.
    function confirm(uint256 id) external onlyOwners {
        Proposal storage p = _mustExist(id);
        if (p.executed) revert AlreadyExecuted(id);
        if (p.cancelled) revert ProposalCancelled(id);
        if (block.timestamp > p.expiresAt) revert Expired(id);
        if (hasConfirmed[id][msg.sender]) revert AlreadyConfirmed(id, msg.sender);
        hasConfirmed[id][msg.sender] = true;
        emit Confirmed(id, msg.sender, _confirmations(id));
    }

    /// @notice Withdraw your approval while the proposal has not executed.
    function revokeConfirmation(uint256 id) external onlyOwners {
        Proposal storage p = _mustExist(id);
        if (p.executed) revert AlreadyExecuted(id);
        if (!hasConfirmed[id][msg.sender]) revert NotConfirmed(id, msg.sender);
        hasConfirmed[id][msg.sender] = false;
        emit ConfirmationRevoked(id, msg.sender, _confirmations(id));
    }

    /**
     * @notice Cancel your own proposal, while it is still short of the threshold.
     * @dev Deliberately narrow: a proposal two owners already approved cannot be pulled by the
     *  proposer alone, or one owner could grief an agreed decision.
     */
    function cancel(uint256 id) external onlyOwners {
        Proposal storage p = _mustExist(id);
        if (p.proposer != msg.sender) revert NotProposer(id);
        if (p.executed) revert AlreadyExecuted(id);
        if (p.cancelled) revert ProposalCancelled(id);
        if (_confirmations(id) >= _requiredFor(p.kind)) revert ConfirmationsLocked(id);
        p.cancelled = true;
        emit Cancelled(id, msg.sender);
    }

    /**
     * @notice Kill a timelocked proposal. ANY ONE OWNER, at any time before it executes.
     *
     * @dev This is the whole defence against two compromised keys, and it is why only
     *  power-EXPANDING proposals are vetoable — a plain transfer is not, so one owner still
     *  cannot block a decision the other two have made.
     *
     *  It cuts both ways, honestly: an owner can veto their own removal. That deadlock is
     *  the lesser evil — nothing can be stolen, and the honest pair can still move everything
     *  to an already-allowlisted address. Which is why you keep one cold address allowlisted.
     */
    function veto(uint256 id) external onlyOwners {
        Proposal storage p = _mustExist(id);
        if (_effectiveAt[id] == 0) revert NotTimelocked(id);
        if (p.executed) revert AlreadyExecuted(id);
        if (p.cancelled) revert ProposalCancelled(id);
        p.cancelled = true;
        emit Vetoed(id, msg.sender);
    }

    // ---------------------------------------------------------------- executing transfers

    /// @notice Execute an approved native transfer.
    function executeNative(uint256 id) external onlyOwners nonReentrant executable(id, Kind.NATIVE) {
        Proposal storage p = _proposals[id];
        // Re-checked at execution, like the confirmation count: removing a recipient must stop a
        // pending transfer to it, not merely prevent new ones.
        _requireAllowedRecipient(p.to);
        uint256 amount = p.value;
        if (address(this).balance < amount) revert InsufficientBalance(address(this).balance, amount);

        p.executed = true; // effects before interaction

        (bool ok,) = payable(p.to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(p.to, amount);

        emit NativeSent(id, p.to, amount);
        emit Executed(id, Kind.NATIVE, msg.sender);
    }

    /**
     * @notice Execute an approved ERC-20 transfer.
     * @dev SafeERC20, not `transfer` + `require(success)`. Tokens that return nothing — USDT and
     *  a long tail of older BEP-20s — make a bool-decoding call revert, which would leave
     *  those balances permanently unwithdrawable.
     */
    function executeERC20(uint256 id) external onlyOwners nonReentrant executable(id, Kind.ERC20) {
        Proposal storage p = _proposals[id];
        _requireAllowedRecipient(p.to);
        _requireAllowedToken(p.token);
        p.executed = true;
        // SYMMETRY WITH depositERC20, added 2026-10-20 after invariant fuzzing found the gap.
        // The entrance measures what ARRIVED and refuses a no-op. The exit used to trust the token
        // and emit the INTENDED amount: a token that returns true without moving anything consumed
        // the proposal and emitted ERC20Sent for value that never left, so every off-chain consumer
        // of that event — the listeners, and the mail they send — was told a lie. A fee-on-transfer
        // token needs no malice to produce the same overstatement. Measure what actually left,
        // refuse a no-op, report the truth.
        uint256 before = IERC20(p.token).balanceOf(address(this));
        IERC20(p.token).safeTransfer(p.to, p.value);
        uint256 sent = before - IERC20(p.token).balanceOf(address(this));
        if (sent == 0) revert ZeroAmount();
        emit ERC20Sent(id, p.token, p.to, sent);
        emit Executed(id, Kind.ERC20, msg.sender);
    }

    /// @notice Execute an approved ERC-721 transfer.
    function executeERC721(uint256 id) external onlyOwners nonReentrant executable(id, Kind.ERC721) {
        Proposal storage p = _proposals[id];
        _requireAllowedRecipient(p.to);
        _requireAllowedToken(p.token);
        p.executed = true;
        IERC721(p.token).safeTransferFrom(address(this), p.to, p.value);
        emit ERC721Sent(id, p.token, p.to, p.value);
        emit Executed(id, Kind.ERC721, msg.sender);
    }

    /// @notice Execute an approved ERC-1155 transfer.
    function executeERC1155(uint256 id) external onlyOwners nonReentrant executable(id, Kind.ERC1155) {
        Proposal storage p = _proposals[id];
        _requireAllowedRecipient(p.to);
        _requireAllowedToken(p.token);
        p.executed = true;
        IERC1155(p.token).safeTransferFrom(address(this), p.to, p.value, p.amount, "");
        emit ERC1155Sent(id, p.token, p.to, p.value, p.amount);
        emit Executed(id, Kind.ERC1155, msg.sender);
    }

    /// @notice Execute an approved NFT batch. All or nothing: one failing item reverts the set.
    function executeNFTBatch(uint256 id)
        external
        onlyOwners
        nonReentrant
        executable(id, Kind.NFT_BATCH)
    {
        Proposal storage p = _proposals[id];
        _requireAllowedRecipient(p.to);
        p.executed = true;

        BatchItem[] storage items = _batches[id];
        uint256 n = items.length;
        for (uint256 i; i < n; ++i) {
            BatchItem storage it = items[i];
            _requireAllowedToken(it.token);
            if (it.standard == Standard.ERC721) {
                IERC721(it.token).safeTransferFrom(address(this), p.to, it.id);
                emit ERC721Sent(id, it.token, p.to, it.id);
            } else {
                IERC1155(it.token).safeTransferFrom(address(this), p.to, it.id, it.amount, "");
                emit ERC1155Sent(id, it.token, p.to, it.id, it.amount);
            }
        }

        emit NFTBatchSent(id, p.to, n);
        emit Executed(id, Kind.NFT_BATCH, msg.sender);
    }

    // ---------------------------------------------------------------- executing governance

    /**
     * @notice The incoming owner accepts a replacement that two owners have approved.
     * @dev A separate transaction from their own address, so a mistyped address can never take a
     *  seat. Allowed during the timelock — consent is not a vote.
     */
    function acceptOwnerReplacement(uint256 id) external {
        Proposal storage p = _mustExist(id);
        if (p.kind != Kind.OWNER_REPLACE) revert WrongKind(id);
        if (p.executed) revert AlreadyExecuted(id);
        if (p.cancelled) revert ProposalCancelled(id);
        if (block.timestamp > p.expiresAt) revert Expired(id);
        if (msg.sender != p.to) revert NotIncomingOwner(id, msg.sender);
        if (p.accepted) revert AlreadyAccepted(id);
        uint256 c = _confirmations(id);
        if (c < THRESHOLD) revert NotEnoughConfirmations(id, c, THRESHOLD);

        p.accepted = true;
        emit OwnerReplacementAccepted(id, msg.sender);
    }

    /// @notice Execute an accepted, matured owner replacement. The set remains exactly three.
    function executeOwnerReplacement(uint256 id)
        external
        onlyOwners
        nonReentrant
        executable(id, Kind.OWNER_REPLACE)
    {
        Proposal storage p = _proposals[id];
        if (!p.accepted) revert NotAccepted(id);
        // Re-check at execution: the set may have changed since the proposal was made.
        if (!isOwner[p.subject]) revert SubjectNotOwner(p.subject);
        if (isOwner[p.to]) revert DuplicateOwner(p.to);

        p.executed = true;

        for (uint256 i; i < OWNER_COUNT; ++i) {
            if (_owners[i] == p.subject) {
                _owners[i] = p.to;
                break;
            }
        }
        isOwner[p.subject] = false;
        isOwner[p.to] = true;

        emit OwnerReplaced(id, p.subject, p.to);
        emit Executed(id, Kind.OWNER_REPLACE, msg.sender);
    }

    /// @notice Execute a matured, unanimous recipient allowlisting.
    function executeAllowRecipient(uint256 id)
        external
        onlyOwners
        executable(id, Kind.ALLOW_RECIPIENT)
    {
        Proposal storage p = _proposals[id];
        if (_recipients[p.to].allowed) revert AlreadyAllowed(p.to);
        p.executed = true;
        _allowRecipient(p.to, _label[id]);
        emit Executed(id, Kind.ALLOW_RECIPIENT, msg.sender);
    }

    /// @notice Execute a recipient removal. Takes effect at once.
    function executeRevokeRecipient(uint256 id)
        external
        onlyOwners
        executable(id, Kind.REVOKE_RECIPIENT)
    {
        Proposal storage p = _proposals[id];
        if (!_recipients[p.to].allowed) revert NotAllowed(p.to);
        p.executed = true;
        _recipients[p.to].allowed = false;
        emit RecipientRevoked(p.to);
        emit Executed(id, Kind.REVOKE_RECIPIENT, msg.sender);
    }

    /// @notice Execute a token allowlisting.
    function executeAllowToken(uint256 id) external onlyOwners executable(id, Kind.ALLOW_TOKEN) {
        Proposal storage p = _proposals[id];
        if (_tokens[p.token].allowed) revert AlreadyAllowed(p.token);
        p.executed = true;
        _allowToken(p.token, _label[id]);
        emit Executed(id, Kind.ALLOW_TOKEN, msg.sender);
    }

    /// @notice Execute a token removal. Takes effect at once.
    function executeRevokeToken(uint256 id) external onlyOwners executable(id, Kind.REVOKE_TOKEN) {
        Proposal storage p = _proposals[id];
        if (!_tokens[p.token].allowed) revert NotAllowed(p.token);
        p.executed = true;
        _tokens[p.token].allowed = false;
        emit TokenRevoked(p.token);
        emit Executed(id, Kind.REVOKE_TOKEN, msg.sender);
    }

    /// @notice Execute a policy change.
    function executeSetPolicy(uint256 id) external onlyOwners executable(id, Kind.SET_POLICY) {
        Proposal storage p = _proposals[id];
        p.executed = true;
        uint64 nd = uint64(p.value);
        // Re-validated at execution: the bounds are constants, but a proposal made long ago must
        // not be able to land a value outside them if anything about the state has moved.
        if (nd < MIN_DELAY || nd > MAX_DELAY) revert BadDelay(nd);
        delay = nd;
        requireAllowedRecipient = (p.amount & 1) != 0;
        requireAllowedToken = (p.amount & 2) != 0;
        emit PolicyChanged(nd, requireAllowedRecipient, requireAllowedToken);
        emit Executed(id, Kind.SET_POLICY, msg.sender);
    }

    // ---------------------------------------------------------------- views

    function owners() external view returns (address[OWNER_COUNT] memory) {
        return _owners;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        _mustExist(id);
        return _proposals[id];
    }

    function getBatch(uint256 id) external view returns (BatchItem[] memory) {
        _mustExist(id);
        return _batches[id];
    }

    /// @notice When a timelocked proposal matures. 0 means it is not timelocked at all.
    function effectiveAt(uint256 id) external view returns (uint64) {
        _mustExist(id);
        return _effectiveAt[id];
    }

    /// @notice The label carried by a governance proposal, if any.
    function proposalLabel(uint256 id) external view returns (string memory) {
        _mustExist(id);
        return _label[id];
    }

    /// @notice Approvals a proposal holds right now, counted over the CURRENT owner set.
    function confirmations(uint256 id) external view returns (uint256) {
        _mustExist(id);
        return _confirmations(id);
    }

    /// @notice How many approvals this proposal's kind needs — 3 for ALLOW_RECIPIENT, else 2.
    function requiredConfirmations(uint256 id) external view returns (uint256) {
        return _requiredFor(_mustExist(id).kind);
    }

    /// @notice Whether this proposal could execute in this block.
    function isExecutable(uint256 id) external view returns (bool) {
        if (id == 0 || id > proposalCount) return false;
        Proposal storage p = _proposals[id];
        if (p.executed || p.cancelled || block.timestamp > p.expiresAt) return false;
        uint64 eff = _effectiveAt[id];
        if (eff != 0 && block.timestamp < eff) return false;
        if (p.kind == Kind.OWNER_REPLACE && !p.accepted) return false;
        return _confirmations(id) >= _requiredFor(p.kind);
    }

    function nativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function erc20Balance(address token) external view returns (uint256) {
        if (token == address(0)) revert ZeroAddress();
        return IERC20(token).balanceOf(address(this));
    }

    function erc721Owned(address token, uint256 tokenId) external view returns (bool) {
        if (token == address(0)) revert ZeroAddress();
        return IERC721(token).ownerOf(tokenId) == address(this);
    }

    function erc1155Balance(address token, uint256 tokenId) external view returns (uint256) {
        if (token == address(0)) revert ZeroAddress();
        return IERC1155(token).balanceOf(address(this), tokenId);
    }

    // ── registry reads ──────────────────────────────────────────────────────────────────────

    function isTokenAllowed(address token) external view returns (bool) {
        return _tokens[token].allowed;
    }

    function isRecipientAllowed(address recipient) external view returns (bool) {
        return _recipients[recipient].allowed;
    }

    function tokenEntry(address token) external view returns (Entry memory) {
        return _tokens[token];
    }

    function recipientEntry(address recipient) external view returns (Entry memory) {
        return _recipients[recipient];
    }

    /// @notice Every token currently allowed, with its label.
    function allowedTokens() external view returns (address[] memory list, string[] memory labels) {
        return _collect(_tokenList, _tokens);
    }

    /// @notice Every destination currently allowed, with its label.
    function allowedRecipients() external view returns (address[] memory list, string[] memory labels) {
        return _collect(_recipientList, _recipients);
    }

    /// @notice Everything ever registered as a token, allowed or since revoked.
    function registeredTokenCount() external view returns (uint256) {
        return _tokenList.length;
    }

    /// @notice Everything ever registered as a recipient, allowed or since revoked.
    function registeredRecipientCount() external view returns (uint256) {
        return _recipientList.length;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Only ALLOW_RECIPIENT needs all three. See the note on `proposeAllowRecipient`.
    function _requiredFor(Kind k) private pure returns (uint256) {
        return k == Kind.ALLOW_RECIPIENT ? UNANIMOUS : THRESHOLD;
    }

    function _transferExpiry(uint64 ttl) private view returns (uint64) {
        if (ttl < MIN_TTL || ttl > MAX_TTL) revert BadTtl(ttl);
        return uint64(block.timestamp) + ttl;
    }

    function _create(Kind kind,
        address token,
        address to,
        address subject,
        uint256 value,
        uint256 amount,
        uint64 expiresAt
    ) private returns (uint256 id) {
        id = ++proposalCount;
        Proposal storage p = _proposals[id];
        p.kind = kind;
        p.token = token;
        p.to = to;
        p.subject = subject;
        p.value = value;
        p.amount = amount;
        p.expiresAt = expiresAt;
        p.proposer = msg.sender;

        // Proposing is an approval; the proposer does not confirm twice.
        hasConfirmed[id][msg.sender] = true;

        emit Proposed(id, kind, msg.sender, expiresAt);
        emit Confirmed(id, msg.sender, 1);
    }

    /**
     * @dev Governance proposals take no ttl from the caller. If they did, someone could pick a
     *  lifetime shorter than the timelock and create a proposal that can never execute.
     *  `timelocked` is decided by the CALLER's own policy logic, not guessed here.
     */
    function _createGovernance(Kind kind,
        address token,
        address to,
        address subject,
        uint256 value,
        uint256 amount,
        string memory label,
        bool timelocked
    ) private returns (uint256 id) {
        uint64 eff = timelocked ? uint64(block.timestamp) + delay : 0;
        uint64 expiresAt = (timelocked ? eff : uint64(block.timestamp)) + EXECUTION_WINDOW;

        id = _create(kind, token, to, subject, value, amount, expiresAt);

        if (timelocked) {
            _effectiveAt[id] = eff;
            emit Scheduled(id, eff, delay);
        }
        if (bytes(label).length != 0) _label[id] = label;
    }

    /// @dev Counted over the current owners on purpose — see the note at the top of the file.
    function _confirmations(uint256 id) private view returns (uint256 c) {
        for (uint256 i; i < OWNER_COUNT; ++i) {
            if (hasConfirmed[id][_owners[i]]) ++c;
        }
    }

    function _mustExist(uint256 id) private view returns (Proposal storage p) {
        if (id == 0 || id > proposalCount) revert NoSuchProposal(id);
        p = _proposals[id];
    }

    function _requireRecipient(address to) private view {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert SelfRecipient();
        _requireAllowedRecipient(to);
    }

    function _requireAllowedRecipient(address to) private view {
        if (requireAllowedRecipient && !_recipients[to].allowed) revert RecipientNotAllowed(to);
    }

    function _requireAllowedToken(address token) private view {
        if (requireAllowedToken && !_tokens[token].allowed) revert TokenNotAllowed(token);
    }

    function _allowRecipient(address recipient, string memory label) private {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert SelfRecipient();
        Entry storage e = _recipients[recipient];
        if (e.allowed) revert AlreadyAllowed(recipient);
        if (e.addedAt == 0) _recipientList.push(recipient);
        e.label = label;
        e.allowed = true;
        e.addedAt = uint64(block.timestamp);
        emit RecipientAllowed(recipient, label);
    }

    function _allowToken(address token, string memory label) private {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(this)) revert SelfRecipient();
        Entry storage e = _tokens[token];
        if (e.allowed) revert AlreadyAllowed(token);
        if (e.addedAt == 0) _tokenList.push(token);
        e.label = label;
        e.allowed = true;
        e.addedAt = uint64(block.timestamp);
        emit TokenAllowed(token, label);
    }

    /// @dev Two passes: count the still-allowed entries, then fill. Revoked entries stay in the
    ///  list so the history is readable, but they must not appear as allowed.
    function _collect(address[] storage keys, mapping(address => Entry) storage reg)
        private
        view
        returns (address[] memory list, string[] memory labels)
    {
        uint256 n = keys.length;
        // Explicit zeroes: Solidity already does this, but Slither reports an unassigned local as
        // a MEDIUM `uninitialized-local`, and the optimizer removes the redundant store.
        uint256 live = 0;
        for (uint256 i; i < n; ++i) {
            if (reg[keys[i]].allowed) ++live;
        }
        list = new address[](live);
        labels = new string[](live);
        uint256 j = 0;
        for (uint256 i; i < n; ++i) {
            address k = keys[i];
            if (reg[k].allowed) {
                list[j] = k;
                labels[j] = reg[k].label;
                ++j;
            }
        }
    }
}
