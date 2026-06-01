import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface CustomSelectProps<T extends string> {
  options: Array<SelectOption<T>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
}

export function CustomSelect<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className = "",
  menuClassName = "",
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const toggleOpen = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const menuHeight = Math.min(options.length * 33 + 8, 224);
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < menuHeight && rect.top > menuHeight);
    }
    setOpen((current) => !current);
  };

  return (
    <div className="relative w-full text-left" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={toggleOpen}
        className={`flex items-center justify-between gap-2 outline-none ${
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        } ${className}`}
      >
        <span className="truncate">
          {options.find((option) => option.value === value)?.label || value}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 opacity-60 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          className={`absolute z-50 max-h-56 overflow-y-auto rounded-lg border th-border th-bg-surface py-1 shadow-2xl backdrop-blur-md ${
            openUpward ? "bottom-full mb-1" : "mt-1"
          } ${
            menuClassName || "left-0 w-full min-w-[8rem]"
          }`}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              className={`w-full px-3 py-2 text-left text-xs transition-colors hover:bg-cyan-500/10 ${
                value === option.value
                  ? "bg-cyan-500/5 font-medium text-cyan-400"
                  : "th-text"
              }`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
