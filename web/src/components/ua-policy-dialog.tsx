'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Trash2 } from 'lucide-react';
import { getUaPolicy, setUaPolicy, deleteUaPolicy } from '@/lib/api';

interface UaPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'global' | 'user' | 'app' | 'api_key';
  /** Undefined for the global level. */
  id?: number;
  label: string;
}

// '__unset__' sentinel keeps the Select always populated while meaning
// "no policy row → unrestricted" (same convention as model-policy-dialog).
const MODE_UNSET = '__unset__';

const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_COUNT = 100;

/**
 * Shared UA allow/block list editor for all four target levels (settings
 * page passes type='global'; users/apps/api-keys pages pass the entity's
 * type+id). Semantics are STACKED — see the description text below.
 */
export function UaPolicyDialog({ open, onOpenChange, type, id, label }: UaPolicyDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<string>(MODE_UNSET);
  const [patternsText, setPatternsText] = useState('');
  // Whether a policy row existed when the dialog loaded — saving "__unset__"
  // only needs a DELETE when there is something to remove.
  const [hadPolicy, setHadPolicy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getUaPolicy(type, id)
      .then((policy) => {
        if (cancelled) return;
        if (policy) {
          setHadPolicy(true);
          setMode(policy.mode);
          setPatternsText(policy.patterns.join('\n'));
        } else {
          setHadPolicy(false);
          setMode(MODE_UNSET);
          setPatternsText('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHadPolicy(false);
          setMode(MODE_UNSET);
          setPatternsText('');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, type, id]);

  function parsePatterns(): { patterns: string[]; error?: string } {
    const patterns = patternsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (patterns.length > MAX_PATTERN_COUNT) {
      return { patterns, error: `正则条数(${patterns.length})超过上限 ${MAX_PATTERN_COUNT}` };
    }
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].length > MAX_PATTERN_LENGTH) {
        return { patterns, error: `第 ${i + 1} 条正则超过 ${MAX_PATTERN_LENGTH} 字符上限` };
      }
      try {
        new RegExp(patterns[i], 'i');
      } catch (err) {
        return { patterns, error: `第 ${i + 1} 条正则语法错误: ${(err as Error).message}` };
      }
    }
    return { patterns };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (mode === MODE_UNSET) {
      // Choosing "未配置" removes the restriction (no-op when none existed).
      setSaving(true);
      try {
        if (hadPolicy) await deleteUaPolicy(type, id);
        onOpenChange(false);
      } catch (err) {
        alert(err instanceof Error ? err.message : '清除 UA 名单失败');
      } finally {
        setSaving(false);
      }
      return;
    }

    const { patterns, error } = parsePatterns();
    if (error) {
      alert(error);
      return;
    }
    if (mode === 'allow' && patterns.length === 0) {
      // Mirrors the backend 400 — surface it client-side with a clearer hint.
      alert('白名单不能为空(空白名单会拒绝全部请求);如需清除限制请选择「未配置」');
      return;
    }

    setSaving(true);
    try {
      await setUaPolicy(type, id, { mode: mode as 'block' | 'allow', patterns });
      onOpenChange(false);
    } catch (err) {
      // Backend 400s (dangerous constructs etc.) carry actionable messages.
      alert(err instanceof Error ? err.message : '保存 UA 名单失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    try {
      await deleteUaPolicy(type, id);
      onOpenChange(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : '清除 UA 名单失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>UA 名单</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">名单模式</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MODE_UNSET}>未配置(默认放行)</SelectItem>
                  <SelectItem value="block">黑名单(命中即拒绝)</SelectItem>
                  <SelectItem value="allow">白名单(仅命中放行)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                四级(全局/用户/应用/密钥)叠加判定:黑名单任一级命中即拒绝;配置了白名单的级要求
                User-Agent 必须匹配该级白名单。下级配置不会放宽上级限制。
              </p>
            </div>

            {mode !== MODE_UNSET && (
              <div className="space-y-1">
                <Label className="text-xs">正则列表(每行一条,不区分大小写)</Label>
                <Textarea
                  rows={6}
                  value={patternsText}
                  onChange={(e) => setPatternsText(e.target.value)}
                  placeholder={'^curl\npython-requests\n^(my-app)/'}
                />
                <p className="text-xs text-muted-foreground">
                  每条 ≤{MAX_PATTERN_LENGTH} 字符、最多 {MAX_PATTERN_COUNT} 条;{'^$'}
                  可拦截无 User-Agent 的客户端;嵌套量词等危险构造会被拒绝(防灾难性回溯)。
                  配置保存后最长 5 秒内生效。
                </p>
              </div>
            )}

            <DialogFooter className="sm:justify-between">
              {hadPolicy ? (
                <Button type="button" variant="outline" onClick={handleClear} disabled={saving}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  清除限制
                </Button>
              ) : <span />}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {saving ? '保存中...' : '保存'}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
