import React, { useId } from "react";
import { Icon } from "./Icon";

export type DispatchFieldType = "string" | "number" | "boolean" | "choice" | "environment";

export interface DispatchFieldProps {
  type: DispatchFieldType;
  name: string;
  label: string;
  required?: boolean | undefined;
  value?: string | boolean | number | undefined;
  options?: readonly string[] | undefined;
  description?: string | undefined;
  defaultValue?: string | boolean | number | undefined;
  placeholder?: string | undefined;
  error?: string | undefined;
  changed?: boolean | undefined;
  disabled?: boolean | undefined;
  sensitive?: boolean | undefined;
  onChange?: ((value: string) => void) | undefined;
}

export function DispatchField({
  type,
  name,
  label,
  required = false,
  value,
  options = [],
  description,
  defaultValue,
  placeholder,
  error,
  changed = false,
  disabled = false,
  sensitive = false,
  onChange,
}: DispatchFieldProps): React.JSX.Element {
  const inputId = useId();
  const listId = useId();
  const stringValue = value === undefined ? "" : String(value);

  return (
    <div className={`ad-field ${changed ? "ad-field--changed" : ""} ${error ? "ad-field--invalid" : ""}`}>
      <label className="ad-field__label" htmlFor={inputId}>
        <span>{label}</span>
        <span className="ad-field__type">
          {type === "environment" ? <Icon name="globe" size={12} tone="muted" /> : null}
          <span>{type}</span>
        </span>
        {required ? <span className="ad-req">required</span> : null}
        {label !== name ? <code className="ad-field__key ad-mono-sm">{name}</code> : null}
      </label>

      {type === "boolean" ? (
        <label className="ad-check" htmlFor={inputId}>
          <input
            id={inputId}
            type="checkbox"
            disabled={disabled}
            checked={stringValue === "true"}
            onChange={(event) => onChange?.(event.target.checked ? "true" : "false")}
          />
          <span className="ad-caption ad-muted">
            {stringValue === "true" ? "true" : "false"}
          </span>
        </label>
      ) : type === "choice" ? (
        <span className="ad-select">
          <select
            id={inputId}
            disabled={disabled}
            value={stringValue}
            onChange={(event) => onChange?.(event.target.value)}
          >
            {!required ? <option value="">—</option> : null}
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={12} />
        </span>
      ) : (
        <>
          <input
            id={inputId}
            className={`ad-input ${error ? "ad-input--error" : ""}`}
            type={sensitive ? "password" : type === "number" ? "number" : "text"}
            disabled={disabled}
            value={stringValue}
            placeholder={placeholder}
            list={type === "environment" && options.length > 0 ? listId : undefined}
            aria-invalid={error ? "true" : undefined}
            onChange={(event) => onChange?.(event.target.value)}
          />
          {type === "environment" && options.length > 0 ? (
            <datalist id={listId}>
              {options.map((opt) => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
          ) : null}
        </>
      )}

      {changed ? (
        <div className="ad-field__changed">
          <Icon name="warning" size={12} tone="warning" />
          <span>Changed locally, preview only</span>
        </div>
      ) : null}

      {description || (defaultValue !== undefined && !sensitive) ? (
        <div className="ad-field__help">
          {description}
          {description && defaultValue !== undefined && !sensitive ? " · " : null}
          {defaultValue !== undefined && !sensitive ? (
            <>
              default <code>{String(defaultValue)}</code>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="ad-field__error" role="alert">
          <Icon name="error" size={14} tone="failure" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
