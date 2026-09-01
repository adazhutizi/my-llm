'use client';

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { getGlobalRateLimit, updateGlobalRateLimit, getLogRetention, updateLogRetention, getSystemInfo, changePassword, listProviders } from '@/lib/api';
import { RateLimitConfig, SystemInfo, Provider } from '@/lib/types';
import { tokensToMillions, millionsToTokens } from '@/lib/utils';
import { Loader2, Check, Save, Info, User, KeyRound } from 'lucide-react';

export default function SettingsPage() {
  const { user } = useAuth();
  const [form, setForm] = useState({ rpm: 60, qps: 10, dailyTokens: '', monthlyTokens: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Log retention (request_details / request_logs max age in days)
  const [logForm, setLogForm] = useState({ detailsRetentionDays: 30, logsRetentionDays: 180 });
  const [logSaving, setLogSaving] = useState(false);
  const [logSaved, setLogSaved] = useState(false);

  // Log analysis: provider + real model name used by the "AI 小结" feature.
  // Empty until the admin configures it; the summary endpoint refuses with 400.
  const [analysisForm, setAnalysisForm] = useState({ provider: '', model: '' });
  const [analysisSaving, setAnalysisSaving] = useState(false);
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);

  // Summary template (system prompt) for "AI 小结". promptForm holds the
  // *effective* value (saved custom template, or the built-in default when
  // unset) so the Textarea always shows something editable. "恢复默认" PUTs ''
  // to clear the custom override; the backend then uses the built-in default.
  const [promptForm, setPromptForm] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptSaved, setPromptSaved] = useState(false);

  // 智能分析 Agent config: a TOOL-CAPABLE model that drives the /analysis
  // chat page's server-side tool-calling loop. Separate from analysisModel
  // (a 1M-window summarizer need not support tools). Empty until configured —
  // /analysis/chat refuses with 400.
  const [agentForm, setAgentForm] = useState({ provider: '', model: '' });
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentSaved, setAgentSaved] = useState(false);
  // Agent system prompt — same effective/default pattern as the summary template.
  const [agentPromptForm, setAgentPromptForm] = useState('');
  const [agentPromptSaving, setAgentPromptSaving] = useState(false);
  const [agentPromptSaved, setAgentPromptSaved] = useState(false);
  // Whether reasoning summary streaming is enabled for the analysis agent.
  // Default true; only relevant for reasoning models (o-series / gpt-5).
  const [agentReasoningEnabled, setAgentReasoningEnabled] = useState(true);
  const [agentReasoningSaving, setAgentReasoningSaving] = useState(false);
  const [agentReasoningSaved, setAgentReasoningSaved] = useState(false);

  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  // Password change state
  const [pwForm, setPwForm] = useState({ current: '', newPass: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  useEffect(() => {
    getGlobalRateLimit().then((data) => {
      if (data) {
        setForm({
          rpm: data.rpm ?? 60,
          qps: data.qps ?? 10,
          dailyTokens: data.dailyTokens != null ? tokensToMillions(data.dailyTokens) : '',
          monthlyTokens: data.monthlyTokens != null ? tokensToMillions(data.monthlyTokens) : '',
        });
      }
    });

    getLogRetention()
      .then((data) => {
        setLogForm({
          detailsRetentionDays: data.detailsRetentionDays,
          logsRetentionDays: data.logsRetentionDays,
        });
        setAnalysisForm({ provider: data.analysisProvider, model: data.analysisModel });
        setPromptForm(data.analysisPromptTemplate || data.analysisPromptTemplateDefault);
        setAgentForm({ provider: data.analysisAgentProvider, model: data.analysisAgentModel });
        setAgentPromptForm(data.analysisAgentSystemPrompt || data.analysisAgentSystemPromptDefault);
        setAgentReasoningEnabled(data.analysisAgentReasoningEnabled);
      })
      .catch(() => {
        // keep defaults if settings aren't available yet
      });

    listProviders().then(setProviders).catch(() => {});

    getSystemInfo().then((info) => {
      setSystemInfo(info);
    });
  }, []);

  async function saveRateLimits() {
    setSaving(true);
    const data: Partial<RateLimitConfig> = {
      rpm: form.rpm,
      qps: form.qps,
      dailyTokens: millionsToTokens(form.dailyTokens),
      monthlyTokens: millionsToTokens(form.monthlyTokens),
    };
    await updateGlobalRateLimit(data);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function saveLogRetention() {
    setLogSaving(true);
    try {
      const data = await updateLogRetention({
        detailsRetentionDays: logForm.detailsRetentionDays,
        logsRetentionDays: logForm.logsRetentionDays,
      });
      setLogForm({
        detailsRetentionDays: data.detailsRetentionDays,
        logsRetentionDays: data.logsRetentionDays,
      });
      setLogSaved(true);
      setTimeout(() => setLogSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setLogSaving(false);
    }
  }

  async function saveAnalysis() {
    setAnalysisSaving(true);
    try {
      const data = await updateLogRetention({
        analysisProvider: analysisForm.provider,
        analysisModel: analysisForm.model,
      });
      setAnalysisForm({ provider: data.analysisProvider, model: data.analysisModel });
      setAnalysisSaved(true);
      setTimeout(() => setAnalysisSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setAnalysisSaving(false);
    }
  }

  async function savePrompt() {
    setPromptSaving(true);
    try {
      const data = await updateLogRetention({ analysisPromptTemplate: promptForm });
      setPromptForm(data.analysisPromptTemplate || data.analysisPromptTemplateDefault);
      setPromptSaved(true);
      setTimeout(() => setPromptSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setPromptSaving(false);
    }
  }

  async function resetPrompt() {
    setPromptSaving(true);
    try {
      // PUT '' clears the custom override; the backend falls back to the
      // built-in DEFAULT_SUMMARY_PROMPT. Refresh the Textarea with the default.
      const data = await updateLogRetention({ analysisPromptTemplate: '' });
      setPromptForm(data.analysisPromptTemplateDefault);
      setPromptSaved(true);
      setTimeout(() => setPromptSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复默认失败');
    } finally {
      setPromptSaving(false);
    }
  }

  async function saveAgent() {
    setAgentSaving(true);
    try {
      const data = await updateLogRetention({
        analysisAgentProvider: agentForm.provider,
        analysisAgentModel: agentForm.model,
      });
      setAgentForm({ provider: data.analysisAgentProvider, model: data.analysisAgentModel });
      setAgentSaved(true);
      setTimeout(() => setAgentSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setAgentSaving(false);
    }
  }

  async function saveAgentPrompt() {
    setAgentPromptSaving(true);
    try {
      const data = await updateLogRetention({ analysisAgentSystemPrompt: agentPromptForm });
      setAgentPromptForm(data.analysisAgentSystemPrompt || data.analysisAgentSystemPromptDefault);
      setAgentPromptSaved(true);
      setTimeout(() => setAgentPromptSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setAgentPromptSaving(false);
    }
  }

  async function resetAgentPrompt() {
    setAgentPromptSaving(true);
    try {
      // PUT '' clears the override; the backend falls back to the built-in
      // DEFAULT_AGENT_SYSTEM_PROMPT. Refresh the Textarea with the default.
      const data = await updateLogRetention({ analysisAgentSystemPrompt: '' });
      setAgentPromptForm(data.analysisAgentSystemPromptDefault);
      setAgentPromptSaved(true);
      setTimeout(() => setAgentPromptSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复默认失败');
    } finally {
      setAgentPromptSaving(false);
    }
  }

  async function saveAgentReasoning() {
    setAgentReasoningSaving(true);
    try {
      const data = await updateLogRetention({ analysisAgentReasoningEnabled: agentReasoningEnabled });
      setAgentReasoningEnabled(data.analysisAgentReasoningEnabled);
      setAgentReasoningSaved(true);
      setTimeout(() => setAgentReasoningSaved(false), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setAgentReasoningSaving(false);
    }
  }

  async function handleChangePassword() {
    setPwError(null);
    setPwSuccess(false);

    if (pwForm.newPass.length < 8) {
      setPwError('新密码长度不能少于 8 位');
      return;
    }
    if (pwForm.newPass !== pwForm.confirm) {
      setPwError('两次输入的新密码不一致');
      return;
    }

    setPwSaving(true);
    try {
      await changePassword(pwForm.current, pwForm.newPass);
      setPwSuccess(true);
      setPwForm({ current: '', newPass: '', confirm: '' });
      setTimeout(() => setPwSuccess(false), 3000);
    } catch (err) {
      const msg = (err as { message?: string })?.message || '修改密码失败';
      setPwError(msg);
    } finally {
      setPwSaving(false);
    }
  }

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>全局限流配置</CardTitle>
            <CardDescription>全网关共享的令牌桶限流;未保存前不生效(无配置时全局限流关闭,仅应用/用户/密钥级限流兜底)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rpm">每分钟请求数 (RPM)</Label>
                <Input
                  id="rpm"
                  type="number"
                  min={1}
                  value={form.rpm}
                  onChange={(e) => setForm({ ...form, rpm: parseInt(e.target.value) || 1 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qps">每秒查询数 (QPS)</Label>
                <Input
                  id="qps"
                  type="number"
                  min={1}
                  value={form.qps}
                  onChange={(e) => setForm({ ...form, qps: parseInt(e.target.value) || 1 })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dailyTokens">每日 Token 限额（M，1M = 100万）</Label>
              <Input
                id="dailyTokens"
                type="number"
                min={0}
                step={0.1}
                placeholder="不限"
                value={form.dailyTokens}
                onChange={(e) => setForm({ ...form, dailyTokens: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="monthlyTokens">每月 Token 限额（M）</Label>
              <Input
                id="monthlyTokens"
                type="number"
                min={0}
                step={0.1}
                placeholder="不限"
                value={form.monthlyTokens}
                onChange={(e) => setForm({ ...form, monthlyTokens: e.target.value })}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={saveRateLimits} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {saving ? '保存中...' : '保存限流配置'}
              </Button>
              {saved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>日志保留</CardTitle>
            <CardDescription>设置日志的最长保留天数，超期数据在每日归并窗口自动清理。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="detailsRetentionDays">详情日志保留天数</Label>
                <Input
                  id="detailsRetentionDays"
                  type="number"
                  min={1}
                  value={logForm.detailsRetentionDays}
                  onChange={(e) => setLogForm({ ...logForm, detailsRetentionDays: parseInt(e.target.value) || 1 })}
                />
                <p className="text-xs text-muted-foreground">含请求/响应大字段，建议保留较短（默认 30 天）</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="logsRetentionDays">列表日志保留天数</Label>
                <Input
                  id="logsRetentionDays"
                  type="number"
                  min={1}
                  value={logForm.logsRetentionDays}
                  onChange={(e) => setLogForm({ ...logForm, logsRetentionDays: parseInt(e.target.value) || 1 })}
                />
                <p className="text-xs text-muted-foreground">轻量列表行，可保留更久（默认 180 天）</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={saveLogRetention} disabled={logSaving}>
                {logSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {logSaving ? '保存中...' : '保存日志配置'}
              </Button>
              {logSaved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>日志分析</CardTitle>
            <CardDescription>
              配置用于「AI 小结」的大模型（建议 1M 窗口小模型，如 Gemini 2.5 Flash / qwen-long / GLM-4-Long）。需先在「服务商」页配置对应上游。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="analysisProvider">服务商</Label>
                <Select
                  value={analysisForm.provider || '__none__'}
                  onValueChange={(v) => setAnalysisForm({ ...analysisForm, provider: v === '__none__' ? '' : v })}
                >
                  <SelectTrigger id="analysisProvider"><SelectValue placeholder="未配置" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未配置</SelectItem>
                    {providers.filter((p) => p.isActive).map((p) => (
                      <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="analysisModel">模型名</Label>
                <Input
                  id="analysisModel"
                  placeholder="如 gemini-2.5-flash / qwen-long"
                  value={analysisForm.model}
                  onChange={(e) => setAnalysisForm({ ...analysisForm, model: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={saveAnalysis} disabled={analysisSaving}>
                {analysisSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {analysisSaving ? '保存中...' : '保存分析配置'}
              </Button>
              {analysisSaved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
            </div>

            <div className="border-t pt-4 space-y-2">
              <Label htmlFor="analysisPromptTemplate">总结模板（System Prompt）</Label>
              <Textarea
                id="analysisPromptTemplate"
                rows={8}
                value={promptForm}
                onChange={(e) => setPromptForm(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                未自定义时使用系统预制模板。修改模板后，已生成的旧小结需在日志详情页点击「重新生成」以应用新模板。
              </p>
              <div className="flex items-center gap-3">
                <Button onClick={savePrompt} disabled={promptSaving}>
                  {promptSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {promptSaving ? '保存中...' : '保存模板'}
                </Button>
                <Button variant="outline" onClick={resetPrompt} disabled={promptSaving}>
                  恢复默认
                </Button>
                {promptSaved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>智能分析 Agent</CardTitle>
            <CardDescription>
              配置「智能分析」对话页使用的模型。仅支持 <strong className="font-medium">OpenAI 类型</strong>服务商（DashScope 归属此类），且模型需<strong className="font-medium">支持工具调用（function calling）</strong>（如 gpt-4o / qwen-plus 工具版）。需先在「服务商」页配置对应上游。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="agentProvider">服务商</Label>
                <Select
                  value={agentForm.provider || '__none__'}
                  onValueChange={(v) => setAgentForm({ ...agentForm, provider: v === '__none__' ? '' : v })}
                >
                  <SelectTrigger id="agentProvider"><SelectValue placeholder="未配置" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未配置</SelectItem>
                    {providers.filter((p) => p.isActive && p.apiType === 'openai').map((p) => (
                      <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agentModel">模型名</Label>
                <Input
                  id="agentModel"
                  placeholder="如 gpt-4o / qwen-plus"
                  value={agentForm.model}
                  onChange={(e) => setAgentForm({ ...agentForm, model: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={saveAgent} disabled={agentSaving}>
                {agentSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {agentSaving ? '保存中...' : '保存 Agent 配置'}
              </Button>
              {agentSaved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
            </div>

            <div className="border-t pt-4 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id="agentReasoning"
                  type="checkbox"
                  checked={agentReasoningEnabled}
                  onChange={(e) => setAgentReasoningEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <Label htmlFor="agentReasoning" className="cursor-pointer">流式输出思考过程（reasoning）</Label>
                <Button size="sm" variant="outline" onClick={saveAgentReasoning} disabled={agentReasoningSaving}>
                  {agentReasoningSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                  {agentReasoningSaving ? '保存中...' : '保存'}
                </Button>
                {agentReasoningSaved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                勾选后推理模型（o 系列 / gpt-5）会在回答前流式输出思考摘要。非推理模型（如 gpt-4o）不支持，勾选会导致请求报错。
              </p>
            </div>

            <div className="border-t pt-4 space-y-2">
              <Label htmlFor="agentSystemPrompt">Agent 系统提示（System Prompt）</Label>
              <Textarea
                id="agentSystemPrompt"
                rows={8}
                value={agentPromptForm}
                onChange={(e) => setAgentPromptForm(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                指导 Agent 如何调用工具、组织中文与表格回答的指令。未自定义时使用系统预制模板。
              </p>
              <div className="flex items-center gap-3">
                <Button onClick={saveAgentPrompt} disabled={agentPromptSaving}>
                  {agentPromptSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {agentPromptSaving ? '保存中...' : '保存模板'}
                </Button>
                <Button variant="outline" onClick={resetAgentPrompt} disabled={agentPromptSaving}>
                  恢复默认
                </Button>
                {agentPromptSaved && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 已保存！</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><User className="h-5 w-5" /> 当前用户</CardTitle>
            <CardDescription>当前登录的管理员账户信息</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">用户名</span>
                <span className="font-medium">{user?.username || '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">角色</span>
                <span className="font-medium">{user?.role === 'super_admin' ? '超级管理员' : '管理员'}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> 修改密码</CardTitle>
            <CardDescription>修改当前管理员账户的登录密码</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">当前密码</Label>
              <Input
                id="currentPassword"
                type="password"
                value={pwForm.current}
                onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">新密码</Label>
              <Input
                id="newPassword"
                type="password"
                placeholder="至少 8 位"
                value={pwForm.newPass}
                onChange={(e) => setPwForm({ ...pwForm, newPass: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">确认新密码</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={pwForm.confirm}
                onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
              />
            </div>

            {pwError && (
              <p className="text-sm text-destructive">{pwError}</p>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={handleChangePassword} disabled={pwSaving || !pwForm.current || !pwForm.newPass || !pwForm.confirm}>
                {pwSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                {pwSaving ? '修改中...' : '修改密码'}
              </Button>
              {pwSuccess && <span className="text-green-600 text-sm flex items-center gap-1"><Check className="h-4 w-4" /> 密码已修改！</span>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Info className="h-5 w-5" /> 系统信息</CardTitle>
          </CardHeader>
          <CardContent>
            {systemInfo ? (
              <div className="space-y-2">
                {[
                  ['版本', systemInfo.version],
                  ['运行时间', systemInfo.uptime],
                  ['数据库', systemInfo.database],
                  ['运行环境', systemInfo.nodeEnv],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">系统信息不可用，请确认管理 API 已启动。</p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
