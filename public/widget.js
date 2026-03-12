class BearlyChange extends HTMLElement {
  connectedCallback() {
    this.limit = Number(this.getAttribute('limit') || 3);
    this.src = this.getAttribute('src');
    if (!this.src) {
      this.innerHTML = '<p>Missing src attribute</p>';
      return;
    }
    this.renderLoading();
    fetch(this.src)
      .then(r => r.json())
      .then(d => this.render(d.entries || []))
      .catch(err => this.renderError(err));
  }

  renderLoading() {
    this.innerHTML = `<div style="font-family:system-ui;border:1px solid #eee;border-radius:12px;padding:14px;">Loading changelog…</div>`;
  }

  renderError(err) {
    this.innerHTML = `<div style="font-family:system-ui;border:1px solid #fdd;border-radius:12px;padding:14px;color:#b00;">Cannot load changelog: ${err.message}</div>`;
  }

  render(entries) {
    const items = entries.slice(0, this.limit).map(e => `
      <li style="padding:10px 0;border-bottom:1px solid #f1f1f1;">
        <div style="font-size:12px;color:#666;text-transform:uppercase;">${e.type} · v${e.version}</div>
        <div style="font-weight:600">${e.title}</div>
        <div style="color:#444;font-size:14px;">${e.summary}</div>
      </li>
    `).join('');

    this.innerHTML = `
      <section style="font-family:system-ui;border:1px solid #eee;border-radius:14px;padding:14px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>Latest changes</strong>
          <span style="font-size:12px;color:#777;">by bearlychange</span>
        </div>
        <ul style="list-style:none;padding:0;margin:8px 0 0 0;">${items}</ul>
      </section>
    `;
  }
}

customElements.define('bearly-change', BearlyChange);
