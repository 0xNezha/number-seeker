// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FHE, ebool, euint32, externalEuint32 } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Number Seeker
/// @notice Players can join to receive an encrypted random number and submit encrypted guesses.
contract NumberSeeker is SepoliaConfig {

    struct PlayerState {
        euint32 secret;
        euint32 lastResult;
        bool joined;
    }

    address private immutable _owner;
    uint256 private _nonce;
    mapping(address => PlayerState) private _players;
    mapping(address => uint256) private _rounds;

    event PlayerJoined(address indexed player, uint256 round);
    event GuessEvaluated(address indexed player, uint256 round);
    event Withdrawal(address indexed recipient, uint256 amount);

    error PlayerNotJoined();
    error InvalidRecipient();
    error InvalidAmount();
    error WithdrawalFailed();
    error NotOwner();

    constructor() {
        _owner = msg.sender;
    }

    /// @notice Joins the game and receives an encrypted secret number between 1 and 10.
    /// @return The encrypted secret assigned to the caller.
    function joinGame() external returns (euint32) {
        uint32 secretValue = _generateSecret(msg.sender);
        euint32 encryptedSecret = FHE.asEuint32(secretValue);

        euint32 resetResult = FHE.asEuint32(0);

        PlayerState storage state = _players[msg.sender];
        state.secret = encryptedSecret;
        state.lastResult = resetResult;
        state.joined = true;

        FHE.allowThis(encryptedSecret);
        FHE.allowThis(resetResult);

        uint256 round = ++_rounds[msg.sender];
        emit PlayerJoined(msg.sender, round);

        return encryptedSecret;
    }

    /// @notice Submits an encrypted guess and stores the encrypted feedback for the caller.
    /// @param encryptedGuess The encrypted guess between 1 and 10.
    /// @param inputProof The proof returned by the relayer when encrypting the guess.
    function submitGuess(externalEuint32 encryptedGuess, bytes calldata inputProof) external {
        PlayerState storage state = _players[msg.sender];
        if (!state.joined) {
            revert PlayerNotJoined();
        }

        euint32 guessValue = FHE.fromExternal(encryptedGuess, inputProof);
        euint32 secretValue = state.secret;

        ebool guessGreaterThanSecret = FHE.gt(guessValue, secretValue);
        euint32 difference = FHE.sub(
            FHE.select(guessGreaterThanSecret, guessValue, secretValue),
            FHE.select(guessGreaterThanSecret, secretValue, guessValue)
        );

        euint32 finalResult = FHE.select(
            FHE.eq(difference, FHE.asEuint32(0)),
            FHE.asEuint32(1),
            FHE.select(
                FHE.eq(difference, FHE.asEuint32(1)),
                FHE.asEuint32(2),
                FHE.select(FHE.eq(difference, FHE.asEuint32(2)), FHE.asEuint32(3), FHE.asEuint32(4))
            )
        );

        state.lastResult = finalResult;
        FHE.allowThis(finalResult);
        FHE.allow(finalResult, msg.sender);

        emit GuessEvaluated(msg.sender, _rounds[msg.sender]);
    }

    /// @notice Returns the encrypted feedback from the latest guess by a player.
    /// @param player The player address to query.
    /// @return The encrypted result where 1 means exact match, 2 within 1, 3 within 2, and 4 otherwise.
    function getLatestResult(address player) external view returns (euint32) {
        return _players[player].lastResult;
    }

    /// @notice Returns the encrypted secret assigned to a player.
    /// @param player The player address to query.
    /// @return The encrypted secret number between 1 and 10.
    function getEncryptedSecret(address player) external view returns (euint32) {
        return _players[player].secret;
    }

    /// @notice Returns whether a player has an active secret.
    /// @param player The player address to query.
    function hasJoined(address player) external view returns (bool) {
        return _players[player].joined;
    }

    /// @notice Returns the number of rounds a player has started.
    /// @param player The player address to query.
    function getRound(address player) external view returns (uint256) {
        return _rounds[player];
    }

    /// @notice Withdraws collected funds to a recipient.
    /// @param recipient The address receiving the funds.
    /// @param amount The amount to withdraw.
    function withdraw(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) {
            revert InvalidRecipient();
        }
        if (amount == 0 || amount > address(this).balance) {
            revert InvalidAmount();
        }

        (bool success, ) = recipient.call{ value: amount }("");
        if (!success) {
            revert WithdrawalFailed();
        }

        emit Withdrawal(recipient, amount);
    }

    /// @notice Returns the address of the contract owner.
    function owner() external view returns (address) {
        return _owner;
    }

    function _generateSecret(address player) private returns (uint32) {
        _nonce++;
        uint256 randomness = uint256(
            keccak256(abi.encodePacked(block.timestamp, blockhash(block.number - 1), player, _nonce))
        );

        return uint32((randomness % 10) + 1);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) {
            revert NotOwner();
        }
        _;
    }
}
