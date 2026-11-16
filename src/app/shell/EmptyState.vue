<script setup lang="ts">
import { bindingOf, run } from './useActions';
import { touch } from './uiState';
import { helpUrl } from '../../deployment';
</script>

<template>
  <div class="es">
    <div class="es__card">
      <svg class="es__art" viewBox="0 0 96 72" aria-hidden="true">
        <path d="M48 6l30 17v26L48 66 18 49V23z" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M18 23l30 17 30-17M48 40v26" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M22 44.5l26 15 26-15M22 38l26 15 26-15M22 31.5l26 15 26-15" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" opacity="0.85" />
      </svg>
      <h2 class="text-base font-semibold text-highlighted mb-1.5">iPadでも、ブラウザでスライス</h2>
      <p class="text-sm text-toned">STL・OBJ・STEP・3MFを開いて始めます。OrcaSlicerのエンジンが、この端末内で処理します。</p>
      <ol class="es__steps">
        <li><strong>1 Import</strong>「ファイル」からモデルを選ぶ</li>
        <li><strong>2 Settings</strong>プリンター・材料・印刷設定を選ぶ</li>
        <li><strong>3 Slice</strong>右上の Slice plate を押す</li>
        <li><strong>4 Export</strong>プレビューを確認し、G-codeを保存</li>
      </ol>
      <p v-if="touch" class="text-xs text-dimmed">設定は左上のサイドバーボタン。2本指でズーム・移動できます。</p>
      <div class="flex flex-wrap justify-center gap-2 mt-4 mb-3">
        <UButton color="primary" icon="i-lucide-file-input" label="モデルを開く · Import" @click="run('file.import')" />
        <UButton color="neutral" variant="ghost" icon="i-lucide-folder-open" label="3MFプロジェクト" @click="run('file.open')" />
      </div>
      <p v-if="!touch" class="text-xs text-dimmed">{{ bindingOf('file.import') }} imports a model. {{ bindingOf('help.palette') }} finds any command.</p>
      <p class="es__note">非公式Web版 · <a :href="helpUrl" target="_blank" rel="noopener">使い方・対応範囲</a><br>Powered by OrcaSlicer &amp; CubbySlicer · AGPL-3.0</p>
    </div>
  </div>
</template>

<style scoped>
.es { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; pointer-events: none; padding: 24px; }
.es__card {
  pointer-events: auto; width: min(400px, 100%); padding: 24px 24px 18px; text-align: center;
  background: color-mix(in srgb, var(--bg-1) 88%, transparent);
  border: 1px dashed var(--line-strong); border-radius: 12px; backdrop-filter: blur(4px);
}
.es__art { width: 64px; height: 48px; margin: 0 auto 10px; }
.es__steps { list-style: none; margin: 14px 0; padding: 0; text-align: left; font-size: var(--fs-sm); color: var(--fg-1); display: grid; gap: 7px; }
.es__steps strong { display: inline-block; min-width: 88px; color: var(--fg-0); }
.es__note { margin-top: 12px; color: var(--fg-2); font-size: var(--fs-xs); line-height: 1.8; }
.es__note a { color: var(--accent); text-decoration: underline; }
@media (max-height: 650px) { .es__art { display: none; } .es__card { max-height: calc(100% - 90px); overflow-y: auto; padding: 16px; } }
</style>
