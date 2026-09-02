'use client';

import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { CheckIcon, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ComboboxOption } from './inline-combobox';

interface InlineMultiComboboxProps {
  options: ComboboxOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
}

/**
 * Multi-select variant of InlineCombobox — also inline-rendered (no Portal,
 * no Popover) so it is safe inside Radix Dialog. The dropdown stays open on
 * item clicks (toggle selection); clicking a selected badge's × removes it.
 */
export function InlineMultiCombobox({
  options,
  values,
  onChange,
  placeholder = '选择...',
  searchPlaceholder = '搜索...',
  emptyText = '未找到',
  disabled = false,
}: InlineMultiComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const valueSet = new Set(values);
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase())
  );

  function toggle(value: string) {
    onChange(valueSet.has(value) ? values.filter((v) => v !== value) : [...values, value]);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        className={cn(
          'flex min-h-9 w-full items-center justify-between gap-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          values.length === 0 && 'text-muted-foreground',
        )}
        onClick={() => {
          if (!open) {
            setSearch('');
          }
          setOpen(!open);
          // Focus the search input after opening
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <span className="flex flex-wrap items-center gap-1 text-left">
          {values.length === 0 ? (
            <span className="px-1">{placeholder}</span>
          ) : (
            values.map((v) => {
              const opt = options.find((o) => o.value === v);
              return (
                <span
                  key={v}
                  className="inline-flex max-w-full items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                >
                  <span className="truncate">{opt?.label ?? v}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="ml-0.5 shrink-0 rounded-sm opacity-60 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        toggle(v);
                      }
                    }}
                  >
                    <X className="h-3 w-3" />
                  </span>
                </span>
              );
            })
          )}
        </span>
        <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="p-1">
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 text-sm"
              autoComplete="off"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">{emptyText}</div>
            ) : (
              filtered.map((o) => (
                <div
                  key={o.value}
                  className={cn(
                    'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
                    'hover:bg-accent hover:text-accent-foreground',
                    valueSet.has(o.value) && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => toggle(o.value)}
                >
                  <CheckIcon
                    className={cn('mr-2 h-4 w-4', valueSet.has(o.value) ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="truncate">{o.label}</span>
                  {o.suffix && (
                    <span className="ml-auto text-xs text-muted-foreground">{o.suffix}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
