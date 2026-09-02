/**
 * ModelPicker.tsx — choose a model, or type one.
 *
 * This was an `<input list=…>` combo box: a text field that offers
 * suggestions. It looks like a dropdown and does not behave like one, and
 * the failure is specific — the field arrives PREFILLED with the current
 * model, so the suggestion list filters itself down to that one entry and
 * appears empty. Reported exactly that way: "I had to wipe the text so all
 * models appeared, like a searchbox not an actual dropdown".
 *
 * A real `<select>` fixes it, and would remove something that matters: a
 * model released this week, or one a self-hosted endpoint serves under its
 * own name, must stay usable without waiting for a release of this app. So
 * the list carries an explicit **Custom…** entry that reveals a text box.
 * The escape hatch is a visible choice rather than a hidden behaviour of a
 * control that looks like something else.
 *
 * One component for all three places that pick a model — the New agent
 * panel, Settings, and Configure — because three copies of a control this
 * fiddly is how they drift.
 */
import { useMemo, useState } from 'react';

/** The sentinel `<option>` value that means "let me type it". */
const CUSTOM = '__custom__';

export function ModelPicker({
  value,
  models,
  placeholder,
  disabled,
  onChange,
  id,
}: {
  value: string;
  /** What the provider serves, as fetched; may be empty while loading. */
  models: { id: string; tested?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (model: string) => void;
  id?: string;
}) {
  /*
   * Typing mode is entered by CHOOSING it, never inferred.
   *
   * The first draft started in typing mode whenever the current model was
   * absent from the list — which is true of every model for the moment
   * before the catalogue loads, and permanently when the machine is offline
   * or the key is wrong. The panel then opened on a text box: precisely the
   * "searchbox not an actual dropdown" this replaced.
   *
   * Instead the current model is always AN OPTION, whether or not the
   * provider listed it. The control is a dropdown from the first frame, it
   * never flickers as the catalogue arrives, and a model typed by hand
   * survives being reopened.
   */
  const [custom, setCustom] = useState(false);

  const options = useMemo(() => {
    const ids = models.map((m) => m.id);
    return value && !ids.includes(value) ? [{ id: value }, ...models] : models;
  }, [models, value]);

  if (custom) {
    return (
      <div className="model-picker">
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        {/*
          A way back, because arriving in typing mode by accident and being
          stuck there is worse than the combo box this replaced.
        */}
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setCustom(false);
            // Back to whatever the list can offer, or empty if it has
            // nothing — either way the control stops being a text box.
            onChange(models[0]?.id ?? '');
          }}
        >
          Choose from the list instead
        </button>
      </div>
    );
  }

  return (
    <div className="model-picker">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            // Cleared, so the field is empty and obviously waiting for input
            // rather than showing a model the user did not choose.
            onChange('');
            return;
          }
          onChange(e.target.value);
        }}
      >
        {/*
          Only while nothing is chosen. A permanent blank option would be a
          way to unset a required field, and provider-and-model is required.
        */}
        {!value && <option value="">{placeholder ?? 'Choose a model'}</option>}

        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
            {m.tested ? ' — verified with tools' : ''}
          </option>
        ))}

        <option value={CUSTOM}>Custom…</option>
      </select>
    </div>
  );
}
