import fs from 'node:fs';

const uiHtml = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

export function renderUi() {
  return uiHtml;
}
