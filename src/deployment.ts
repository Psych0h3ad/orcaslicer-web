/** Capabilities actually shipped by this static, browser-local distribution. */
export const deployment = {
  title: 'OrcaSlicer Web · CubbySlicer',
  engines: ['orca'],
  cloud: false,
  bridge: false,
  pythonPlugins: false,
} as const;

export const helpUrl = `${import.meta.env.BASE_URL}help.html`;

/** Unsupported commands remain registered, but cannot run from any surface. */
export function unavailableAction(id: string): string | null {
  if (!deployment.cloud && id.startsWith('cloud.')) return 'この配布版は端末内で保存します';
  if (!deployment.bridge && id.startsWith('claude.')) return 'この配布版にAI接続サーバーはありません';
  if (!deployment.pythonPlugins && id.startsWith('plugins.')) return 'この配布版はPythonプラグインに未対応です';
  return null;
}

/** Imported projects must never silently lose their configured Python steps. */
export function unsupportedPipelineProblems(config: Record<string, unknown>) {
  const raw = config.slicing_pipeline_plugin;
  const names = (Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === 'string' && v.trim());
  return !deployment.pythonPlugins && names.length ? [{
    key: 'slicing_pipeline_plugin', label: 'Slicing pipeline plugin', severity: 'error' as const,
    message: 'このプロジェクトはPythonプラグインを使用します。この配布版では実行できません。設定で解除するか、デスクトップ版OrcaSlicerで開いてください。',
  }] : [];
}
