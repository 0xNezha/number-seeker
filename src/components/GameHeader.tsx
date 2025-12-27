import '../styles/GameHeader.css';

export function GameHeader() {
  return (
    <header className="game-header">
      <div className="game-header__text">
        <h1 className="game-header__title">🎯 Number Seeker</h1>
        <p className="game-header__subtitle">
          Zero cost. Maximum encryption. 🔐 Decode the mystery digit hidden in the range 1-10.
        </p>
      </div>
    </header>
  );
}
