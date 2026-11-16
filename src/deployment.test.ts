import { describe, expect, it, vi } from 'vitest';
import { deployment, helpUrl, unavailableAction, unsupportedPipelineProblems } from './deployment';
import { builtinActions } from './app/actions/buildActions';
import { runAction } from './app/actions/run';
import { fixtureContext } from './app/actions/testing/fixtureContext';
import { MENU_BAR } from './app/actions/layouts/menus';
import { menuLayoutIds } from './app/actions/project/menu';

describe('static browser-local distribution', () => {
  it('guards unsupported commands on the shared registry, including keyboard invocation', async () => {
    const actions = builtinActions();
    for (const id of ['cloud.open', 'cloud.save', 'claude.connect', 'plugins.open']) {
      const a = actions.find((x) => x.id === id)!;
      expect(a, id).toBeDefined();
      expect(unavailableAction(id)).toBeTruthy();
      expect(a.hidden).toBe(true);
      expect(a.binding).toBeUndefined();
      expect(a.when?.(fixtureContext())).toBe(false);
      const handler = vi.fn();
      await runAction({ ...a, run: handler }, fixtureContext());
      expect(handler).not.toHaveBeenCalled();
    }
    expect(unavailableAction('file.import')).toBeNull();
    expect(deployment.engines).toEqual(['orca']);
    expect(MENU_BAR.flatMap((m) => menuLayoutIds(m.layout)).filter((id) => unavailableAction(id))).toEqual([]);
  });

  it('blocks imported Python pipelines instead of silently skipping their processing', () => {
    expect(unsupportedPipelineProblems({})).toEqual([]);
    expect(unsupportedPipelineProblems({ slicing_pipeline_plugin: ['', ' '] })).toEqual([]);
    expect(unsupportedPipelineProblems({ slicing_pipeline_plugin: ['PostProcess'] })).toEqual([
      expect.objectContaining({ key: 'slicing_pipeline_plugin', severity: 'error', message: expect.stringContaining('デスクトップ版OrcaSlicer') }),
    ]);
  });

  it('offers an in-app guide independently of disabled integrations', () => {
    expect(helpUrl).toMatch(/help\.html$/);
    const guide = builtinActions().find((a) => a.id === 'help.guide');
    expect(guide).toBeDefined();
    expect(guide?.hidden).not.toBe(true);
  });
});
