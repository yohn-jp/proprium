import type { ThemeMode } from "../theme";

export function ThemeControl({
  mode,
  onChange,
  error,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  error?: string;
}) {
  return (
    <label className="theme-control">
      <span>外観</span>
      <select
        aria-label="外観"
        value={mode}
        onChange={(event) => onChange(event.currentTarget.value as ThemeMode)}
      >
        <option value="light">ライト</option>
        <option value="dark">ダーク</option>
        <option value="paper">紙</option>
      </select>
      {error && <span className="theme-error" role="alert">{error}</span>}
    </label>
  );
}
