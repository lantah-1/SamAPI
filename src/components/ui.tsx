import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Children, isValidElement, useEffect, useId, useMemo, useState } from "react";
import { smartModelMatches } from "../app/utils";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className || ""}`} />;
}

export function SecretTextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  const { className, type: _type, ...rest } = props;
  return (
    <div className="secret-field">
      <input
        {...rest}
        type={visible ? "text" : "password"}
        className={`field secret-field-input ${className || ""}`}
        autoComplete={rest.autoComplete || "off"}
        spellCheck={rest.spellCheck ?? false}
      />
      <button
        type="button"
        className="secret-field-toggle"
        aria-label={visible ? "隐藏密钥" : "显示密钥"}
        title={visible ? "隐藏密钥" : "显示密钥"}
        tabIndex={-1}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

function selectOptionLabel(value: React.ReactNode): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(selectOptionLabel).join("");
  return "";
}

type SelectOption = {
  value: string;
  label: string;
  disabled: boolean;
};

const closeSelectInputsEvent = "samapi-close-select-inputs";
let activeSelectInputId: string | null = null;

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, disabled, value, defaultValue, onChange, name } = props;
  const selectId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const currentValue = String(value ?? defaultValue ?? "");
  const options = useMemo<SelectOption[]>(
    () =>
      Children.toArray(children).flatMap((child) => {
        if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: React.ReactNode }>(child)) return [];
        if (child.type !== "option") return [];
        const optionValue = String(child.props.value ?? selectOptionLabel(child.props.children));
        return [
          {
            value: optionValue,
            label: selectOptionLabel(child.props.children) || optionValue || "请选择",
            disabled: Boolean(child.props.disabled)
          }
        ];
      }),
    [children]
  );
  const selectedOption = options.find((option) => option.value === currentValue);
  const showSearch = options.length > 5;
  const visibleOptions = showSearch && query.trim()
    ? options.filter((option) => smartModelMatches(option.label, query) || smartModelMatches(option.value, query))
    : options;

  useEffect(() => {
    const closeFromOtherSelect = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== selectId) setOpen(false);
    };
    window.addEventListener(closeSelectInputsEvent, closeFromOtherSelect);
    return () => window.removeEventListener(closeSelectInputsEvent, closeFromOtherSelect);
  }, [selectId]);

  const commitValue = (nextValue: string) => {
    setOpen(false);
    setQuery("");
    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name }
    } as unknown as React.ChangeEvent<HTMLSelectElement>);
  };

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) {
        if (activeSelectInputId && activeSelectInputId !== selectId) {
          window.dispatchEvent(new CustomEvent(closeSelectInputsEvent, { detail: selectId }));
          activeSelectInputId = null;
          return;
        }
        activeSelectInputId = selectId;
        setOpen(true);
        return;
      }
      if (activeSelectInputId === selectId) activeSelectInputId = null;
      setOpen(false);
      setQuery("");
    }}>
      <span
        className={`select-shell ${disabled ? "select-shell-disabled" : ""}`}
        onPointerDown={() => {
          if (activeSelectInputId && activeSelectInputId !== selectId) {
            window.dispatchEvent(new CustomEvent(closeSelectInputsEvent, { detail: selectId }));
            activeSelectInputId = null;
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`field select-trigger ${className || ""}`}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span className={`select-trigger-value ${selectedOption ? "" : "select-trigger-placeholder"}`}>
              {selectedOption?.label || "请选择"}
            </span>
            <ChevronDown className="select-chevron h-4 w-4" aria-hidden="true" />
          </button>
        </Popover.Trigger>
      </span>
      <Popover.Portal>
        <Popover.Content
          className="select-menu"
          align="start"
          side="bottom"
          sideOffset={6}
          avoidCollisions={false}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {showSearch ? (
            <div className="select-search-row">
              <input
                className="select-search-input"
                value={query}
                placeholder="搜索选项..."
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") setOpen(false);
                }}
              />
            </div>
          ) : null}
          <div className="select-viewport" role="listbox">
            {visibleOptions.length > 0 ? (
              visibleOptions.map((option, index) => (
                <button
                  key={`${option.value}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === currentValue}
                  disabled={option.disabled}
                  className={`select-option ${option.value === currentValue ? "select-option-selected" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!option.disabled) commitValue(option.value);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === currentValue ? <Check className="h-4 w-4" /> : null}
                </button>
              ))
            ) : (
              <div className="select-empty">没有匹配的选项</div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ActionButton({
  children,
  tone = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" }) {
  return (
    <button {...props} className={`action action-${tone} ${props.className || ""}`}>
      {children}
    </button>
  );
}
