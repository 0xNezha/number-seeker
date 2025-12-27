import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, usePublicClient } from 'wagmi';
import { Contract } from 'ethers';

import { GameHeader } from './GameHeader';
import { useEthersSigner } from '../hooks/useEthersSigner';
import { useZamaInstance } from '../hooks/useZamaInstance';
import { CONTRACT_ADDRESS, CONTRACT_ABI } from '../config/contracts';
import '../styles/GameApp.css';

const ZERO_CIPHERTEXT = '0x0000000000000000000000000000000000000000000000000000000000000000';

function interpretResult(value: number) {
  switch (value) {
    case 1:
      return '🎉 JACKPOT! Direct hit on the target.';
    case 2:
      return '🔥 So close! Off by a single digit.';
    case 3:
      return '⚡ Getting warm. Two steps away from victory.';
    case 4:
      return '❌ Off the mark. Recalculate and try again.';
    default:
      return null;
  }
}

export function GameApp() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { instance, isLoading: isZamaLoading, error: zamaError } = useZamaInstance();
  const signer = useEthersSigner();
  const contractAddress = CONTRACT_ADDRESS;
  const isContractConfigured = Boolean(contractAddress && contractAddress.length > 0);

  const [hasJoined, setHasJoined] = useState(false);
  const [round, setRound] = useState<number>(0);
  const [guessValue, setGuessValue] = useState('');
  const [encryptedResult, setEncryptedResult] = useState<string | null>(null);
  const [lastDecryptedCipher, setLastDecryptedCipher] = useState<string | null>(null);
  const [feedbackCode, setFeedbackCode] = useState<number | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [isGuessing, setIsGuessing] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const feedbackMessage = useMemo(() => (feedbackCode !== null ? interpretResult(feedbackCode) : null), [feedbackCode]);

  const refreshPlayerData = useCallback(async () => {
    if (!publicClient || !address || !isContractConfigured) {
      setHasJoined(false);
      setRound(0);
      setEncryptedResult(null);
      setFeedbackCode(null);
      setLastDecryptedCipher(null);
      return;
    }

    try {
      const [joined, activeRound, latestResult] = await Promise.all([
        publicClient.readContract({
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'hasJoined',
          args: [address],
        }) as Promise<boolean>,
        publicClient.readContract({
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'getRound',
          args: [address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'getLatestResult',
          args: [address],
        }) as Promise<string>,
      ]);

      setHasJoined(joined);
      setRound(Number(activeRound));
      setEncryptedResult((previous) => {
        if (previous !== latestResult) {
          setFeedbackCode(null);
          setLastDecryptedCipher(null);
          if (latestResult && latestResult !== ZERO_CIPHERTEXT) {
            setStatusMessage('🔐 Encrypted result ready. Click decrypt to reveal feedback.');
          }
        }
        return latestResult;
      });

      if (!joined) {
        setFeedbackCode(null);
        setLastDecryptedCipher(null);
      }
    } catch (err) {
      console.error('Failed to refresh player data', err);
    }
  }, [address, publicClient, isContractConfigured, contractAddress]);

  useEffect(() => {
    refreshPlayerData();
  }, [refreshPlayerData]);

  const decryptCiphertext = useCallback(
    async (cipher: string) => {
      if (!instance || !address || !isContractConfigured) {
        return;
      }

      if (isDecrypting) {
        return;
      }

      setIsDecrypting(true);
      setStatusMessage('🔓 Initiating decryption sequence...');

      try {
        const keypair = instance.generateKeypair();
        const contractAddresses = [contractAddress];
        const startTimestamp = Math.floor(Date.now() / 1000).toString();
        const durationDays = '10';

        const eip712 = instance.createEIP712(keypair.publicKey, contractAddresses, startTimestamp, durationDays);
        const resolvedSigner = await signer;
        if (!resolvedSigner) {
          throw new Error('Wallet signer is not available');
        }

        const signature = await resolvedSigner.signTypedData(
          eip712.domain,
          { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
          eip712.message,
        );

        const response = await instance.userDecrypt(
          [{ handle: cipher, contractAddress }],
          keypair.privateKey,
          keypair.publicKey,
          signature.replace('0x', ''),
          contractAddresses,
          address,
          startTimestamp,
          durationDays,
        );

        const values = Object.values(response ?? {});
        const rawValue = (response && (response as Record<string, string>)[cipher]) || values[0];

        if (!rawValue) {
          throw new Error('No decrypted value returned');
        }

        const numeric = Number(rawValue);
        if (!Number.isInteger(numeric)) {
          throw new Error('Unexpected decrypted format');
        }

        setFeedbackCode(numeric);
        setLastDecryptedCipher(cipher);
        setStatusMessage('✅ Signal decoded successfully.');
      } catch (err) {
        console.error('Failed to decrypt result', err);
        setStatusMessage(err instanceof Error ? err.message : '❌ Decryption protocol failed');
      } finally {
        setIsDecrypting(false);
      }
    },
    [address, instance, isContractConfigured, isDecrypting, signer],
  );

  useEffect(() => {
    if (!encryptedResult || encryptedResult === ZERO_CIPHERTEXT) {
      return;
    }

    if (!address || !isContractConfigured) {
      return;
    }

    if (encryptedResult !== lastDecryptedCipher) {
      setStatusMessage('🔐 Data encrypted. Awaiting decryption command.');
    }
  }, [address, encryptedResult, isContractConfigured, lastDecryptedCipher]);

  const handleJoin = async () => {
    if (!address) {
      setStatusMessage('⚠️ Wallet connection required to proceed.');
      return;
    }

    if (!isContractConfigured) {
      setStatusMessage('⚠️ Contract node address not configured.');
      return;
    }

    setIsJoining(true);
    setStatusMessage('🔄 Initializing session protocol...');

    try {
      const resolvedSigner = await signer;
      if (!resolvedSigner) {
        throw new Error('Wallet signer is not available');
      }

      const contract = new Contract(contractAddress, CONTRACT_ABI, resolvedSigner);

      const tx = await contract.joinGame();
      await tx.wait();

      setStatusMessage('✅ Session active. Target encrypted and ready for probing.');
      setFeedbackCode(null);
      setLastDecryptedCipher(null);
      await refreshPlayerData();
    } catch (err) {
      console.error('Join transaction failed', err);
      setStatusMessage(err instanceof Error ? err.message : '❌ Mission initialization failed');
    } finally {
      setIsJoining(false);
    }
  };

  const handleGuess = async () => {
    if (!address) {
      setStatusMessage('⚠️ Wallet connection required for probe deployment.');
      return;
    }

    if (!isContractConfigured) {
      setStatusMessage('⚠️ Contract node address not configured.');
      return;
    }

    if (!hasJoined) {
      setStatusMessage('⚠️ Initialize session before deploying probes.');
      return;
    }

    const guessNumber = Number(guessValue.trim());
    if (!Number.isInteger(guessNumber) || guessNumber < 1 || guessNumber > 10) {
      setStatusMessage('❌ Invalid input. Select digit 1-10.');
      return;
    }

    if (!instance) {
      setStatusMessage('⚠️ Cipher engine offline. Please wait.');
      return;
    }

    setIsGuessing(true);
    setStatusMessage('🔐 Encrypting probe data and transmitting...');

    try {
      const resolvedSigner = await signer;
      if (!resolvedSigner) {
        throw new Error('Wallet signer is not available');
      }

      const encryptedInput = await instance
        .createEncryptedInput(contractAddress, address)
        .add32(guessNumber)
        .encrypt();

      const contract = new Contract(contractAddress, CONTRACT_ABI, resolvedSigner);

      const tx = await contract.submitGuess(encryptedInput.handles[0], encryptedInput.inputProof);
      await tx.wait();

      setStatusMessage('✅ Probe deployed. Decrypt scan results to view analysis.');
      setGuessValue('');
      await refreshPlayerData();
    } catch (err) {
      console.error('Guess transaction failed', err);
      setStatusMessage(err instanceof Error ? err.message : '❌ Probe transmission failed');
    } finally {
      setIsGuessing(false);
    }
  };

  const manualDecrypt = async () => {
    if (!encryptedResult || encryptedResult === ZERO_CIPHERTEXT) {
      setStatusMessage('⚠️ No encrypted data available for decryption.');
      return;
    }

    if (!isContractConfigured) {
      setStatusMessage('⚠️ Contract node address not configured.');
      return;
    }

    await decryptCiphertext(encryptedResult);
  };

  return (
    <div className="game-app">
      <div className="game-app__hero">
        <GameHeader />
        <ConnectButton />
      </div>

      <div className="game-app__grid">
        <section className="game-card">
          <h2 className="game-card__title">🚀 Initialize Session</h2>
          <p className="game-card__description">
            Activate your encrypted target and begin the digital hunt. 🎮
          </p>
          <button
            type="button"
            onClick={handleJoin}
            className="primary-button"
            disabled={isJoining || !address || isZamaLoading || !isContractConfigured}
          >
            {isJoining ? '⏳ Initializing...' : hasJoined ? '🔄 Reset Target' : '▶️ Start Mission'}
          </button>

          <div className="game-card__status">
            <p>📊 Mission round: <strong>{round}</strong></p>
            <p>
              🌐 Contract node:
              <strong>
                {isContractConfigured ? ` ${contractAddress}` : ' Set VITE_GAME_CONTRACT_ADDRESS'}
              </strong>
            </p>
            <p>🔐 Cipher engine: <strong>{isZamaLoading ? '⏳ Booting...' : zamaError ? '🔴 Offline' : '🟢 Online'}</strong></p>
          </div>

          {zamaError ? <p className="error-text">{zamaError}</p> : null}
        </section>

        <section className="game-card">
          <h2 className="game-card__title">📡 Deploy Probe</h2>
          <p className="game-card__description">
            Input any digit from 1 to 10. Your probe data will encrypt client-side before transmission. 🛡️
          </p>

          <div className="guess-input">
            <input
              type="number"
              min={1}
              max={10}
              value={guessValue}
              onChange={(event) => setGuessValue(event.target.value)}
              placeholder="🎲 Enter digit"
              className="guess-input__field"
            />
            <button
              type="button"
              onClick={handleGuess}
              className="primary-button"
              disabled={isGuessing || !address || !hasJoined || isZamaLoading || !isContractConfigured}
            >
              {isGuessing ? '📤 Transmitting...' : '🚀 Launch Probe'}
            </button>
          </div>

          <div className="result-card">
            <h3 className="result-card__title">📊 Scan Results</h3>
            <p className="result-card__cipher">
              {encryptedResult && encryptedResult !== ZERO_CIPHERTEXT ? encryptedResult : '⏳ Awaiting probe transmission...'}
            </p>

            <button
              type="button"
              onClick={manualDecrypt}
              className="secondary-button"
              disabled={
                isDecrypting ||
                !encryptedResult ||
                encryptedResult === ZERO_CIPHERTEXT ||
                !address ||
                !isContractConfigured
              }
            >
              {isDecrypting ? '🔓 Decoding...' : '🔍 Decrypt Data'}
            </button>

            {feedbackMessage ? (
              <div className="result-card__feedback">
                <span className="feedback-code">📡 Signal {feedbackCode}</span>
                <p className="feedback-message">{feedbackMessage}</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {statusMessage ? <div className="status-banner">{statusMessage}</div> : null}
    </div>
  );
}
