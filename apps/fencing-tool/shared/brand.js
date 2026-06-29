// ════════════════════════════════════════════════════════════
// SecureWorks — Shared Brand Constants & PDF Helpers
// Include this in any tool that needs brand colours or PDF generation
// ════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // ── Brand Colours (RGB arrays for jsPDF) ──
  const SW_ORANGE = [241, 90, 41];    // #F15A29
  const SW_DARK   = [41, 60, 70];     // #293C46
  const SW_MID    = [76, 106, 124];   // #4C6A7C
  const SW_LIGHT  = [240, 244, 247];  // card backgrounds, alt rows
  const SW_RULE   = [210, 218, 224];  // subtle lines, borders
  const SW_BODY   = [50, 50, 50];     // body text
  const SW_MUTED  = [130, 140, 148];  // fine print, captions

  // ── Brand Colour Hex ──
  const SW_HEX = {
    orange: '#F15A29',
    dark:   '#293C46',
    mid:    '#4C6A7C',
    light:  '#F0F4F7',
    white:  '#FFFFFF'
  };

  // ── PDF Layout Constants ──
  const PDF_M = 14;        // margin (mm)
  const PDF_W = 210;       // A4 width (mm)
  const PDF_H = 297;       // A4 height (mm)
  const PDF_CW = PDF_W - (PDF_M * 2); // content width

  // ── White SVG Logo (for dark backgrounds) ──
  const SW_LOGO_WHITE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 490 79.55"><defs><style>.c1{fill:#fff}.c3{fill:rgba(255,255,255,0.6)}</style></defs><path class="c1" d="M85.11,46.94c.24,1.73,.73,3.02,1.44,3.88,1.31,1.56,3.56,2.34,6.74,2.34,1.91,0,3.45-.21,4.64-.62,2.26-.79,3.38-2.25,3.38-4.39,0-1.25-.55-2.22-1.66-2.9-1.11-.67-2.86-1.26-5.26-1.77l-4.1-.9c-4.03-.89-6.8-1.86-8.3-2.9-2.55-1.75-3.83-4.48-3.83-8.19,0-3.39,1.25-6.21,3.74-8.45s6.16-3.36,11-3.36c4.04,0,7.48,1.06,10.33,3.17,2.85,2.11,4.35,5.18,4.48,9.21h-7.6c-.14-2.28-1.16-3.89-3.05-4.85-1.26-.63-2.83-.95-4.71-.95-2.09,0-3.76,.41-5,1.23-1.25,.82-1.87,1.97-1.87,3.44,0,1.35,.61,2.36,1.84,3.03,.79,.45,2.47,.97,5.03,1.57l6.64,1.57c2.91,.69,5.09,1.6,6.55,2.75,2.26,1.78,3.38,4.36,3.38,7.73s-1.34,6.33-4.01,8.62c-2.67,2.29-6.45,3.43-11.33,3.43s-8.9-1.13-11.76-3.38c-2.86-2.25-4.28-5.35-4.28-9.28h7.55Z"/><path class="c1" d="M130.99,31.2c1.95,.87,3.57,2.26,4.84,4.14,1.15,1.66,1.89,3.59,2.23,5.79,.2,1.29,.28,3.14,.24,5.56h-20.39c.11,2.81,1.09,4.78,2.93,5.91,1.12,.7,2.46,1.05,4.04,1.05,1.67,0,3.02-.43,4.06-1.28,.57-.46,1.07-1.1,1.51-1.93h7.47c-.2,1.66-1.1,3.35-2.71,5.06-2.51,2.72-6.02,4.08-10.53,4.08-3.73,0-7.01-1.15-9.86-3.44-2.85-2.3-4.27-6.03-4.27-11.21,0-4.85,1.28-8.57,3.86-11.16,2.57-2.59,5.91-3.88,10.01-3.88,2.44,0,4.63,.44,6.58,1.31Zm-10.95,6.32c-1.03,1.07-1.68,2.51-1.95,4.33h12.61c-.13-1.94-.78-3.42-1.95-4.42s-2.61-1.51-4.34-1.51c-1.88,0-3.34,.53-4.37,1.6Z"/><path class="c1" d="M157.58,40.68c-.14-1.04-.49-1.99-1.06-2.82-.82-1.13-2.1-1.7-3.84-1.7-2.47,0-4.16,1.22-5.07,3.67-.48,1.3-.72,3.02-.72,5.17s.24,3.7,.72,4.94c.87,2.33,2.52,3.49,4.94,3.49,1.72,0,2.94-.46,3.66-1.39,.72-.92,1.16-2.12,1.31-3.6h7.47c-.17,2.23-.98,4.33-2.42,6.32-2.3,3.2-5.7,4.8-10.21,4.8s-7.82-1.34-9.95-4.01c-2.12-2.67-3.19-6.13-3.19-10.39,0-4.8,1.17-8.54,3.52-11.21,2.35-2.67,5.59-4.01,9.72-4.01,3.51,0,6.39,.79,8.63,2.36,2.24,1.58,3.56,4.36,3.97,8.35h-7.5Z"/><path class="c1" d="M176.23,30.63v16.87c0,1.59,.19,2.79,.56,3.6,.66,1.42,1.97,2.13,3.91,2.13,2.49,0,4.19-1.01,5.11-3.03,.48-1.1,.72-2.54,.72-4.34v-15.23h7.42v27.99h-7.11v-3.96c-.07,.09-.24,.34-.51,.77s-.6,.8-.97,1.13c-1.14,1.03-2.25,1.73-3.32,2.11-1.07,.38-2.32,.57-3.75,.57-4.13,0-6.92-1.49-8.35-4.47-.8-1.64-1.2-4.07-1.2-7.27V30.63h7.5Z"/><path class="c1" d="M215.46,29.98c.09,0,.3,.02,.63,.04v7.5c-.46-.05-.87-.09-1.23-.1-.36-.02-.65-.03-.87-.03-2.95,0-4.92,.96-5.93,2.88-.57,1.08-.85,2.74-.85,4.98v13.38h-7.37V30.63h6.99v4.88c1.13-1.87,2.11-3.14,2.95-3.83,1.37-1.15,3.15-1.72,5.34-1.72,.14,0,.25,0,.35,.01Z"/><path class="c1" d="M237.46,31.2c1.95,.87,3.57,2.26,4.84,4.14,1.15,1.66,1.89,3.59,2.23,5.79,.2,1.29,.28,3.14,.24,5.56h-20.39c.11,2.81,1.09,4.78,2.93,5.91,1.12,.7,2.46,1.05,4.04,1.05,1.67,0,3.02-.43,4.06-1.28,.57-.46,1.07-1.1,1.51-1.93h7.47c-.2,1.66-1.1,3.35-2.71,5.06-2.51,2.72-6.02,4.08-10.53,4.08-3.73,0-7.01-1.15-9.86-3.44-2.85-2.3-4.27-6.03-4.27-11.21,0-4.85,1.28-8.57,3.86-11.16,2.57-2.59,5.91-3.88,10.01-3.88,2.44,0,4.63,.44,6.58,1.31Zm-10.95,6.32c-1.03,1.07-1.68,2.51-1.95,4.33h12.61c-.13-1.94-.78-3.42-1.95-4.42s-2.61-1.51-4.34-1.51c-1.88,0-3.34,.53-4.37,1.6Z"/><path class="c1" d="M257.19,20.77l.39,21.68-.21,6.04,2.36-5.91,8.91-21.8h8.35l-.13,21.68-.13,6.04,2.39-5.8,9.73-21.91h8.04l-18.7,37.86h-7.55l.13-22.14,.21-7.32-2.88,7.32-9.27,22.14h-7.34l-2.7-37.86h8.4Z"/><path class="c1" d="M303.31,59.6c-4.81,0-8.09-1.46-9.82-4.38-1.74-2.92-2.17-6.43-1.3-10.54,.86-4.04,2.78-7.54,5.78-10.5,3-2.96,6.9-4.44,11.71-4.44s8.08,1.48,9.81,4.44c1.73,2.96,2.17,6.46,1.31,10.5-.87,4.11-2.8,7.62-5.79,10.54-2.99,2.92-6.89,4.38-11.7,4.38Zm9.81-14.92c.6-2.81,.48-4.97-.35-6.49-.83-1.52-2.32-2.27-4.46-2.27s-3.95,.76-5.42,2.27c-1.47,1.52-2.51,3.68-3.11,6.49-.6,2.81-.48,4.97,.35,6.5,.83,1.52,2.32,2.29,4.46,2.29s3.95-.76,5.42-2.29,2.51-3.69,3.11-6.5Z"/><path class="c1" d="M344.17,30.02l-1.59,7.5c-.45-.05-.85-.09-1.21-.1-.36-.02-.65-.03-.87-.03-2.94,0-5.13,.96-6.55,2.88-.79,1.08-1.42,2.74-1.9,4.98l-2.83,13.38h-7.37l5.93-27.99h6.99l-1.03,4.88c1.52-1.87,2.77-3.14,3.75-3.83,1.63-1.15,3.54-1.72,5.73-1.72,.14,0,.25,0,.35,.01,.09,0,.3,.02,.6,.04Z"/><path class="c1" d="M349.18,20.9h7.19l-4.34,20.39,11.35-10.53h9.07l-12.07,10.71,6.55,17.16h-8.83l-4.16-11.97-3.72,3.16-1.85,8.81h-7.19l8.01-37.73Z"/><path class="c1" d="M376.91,49.69c-.12,1.3,.03,2.23,.44,2.77,.68,.98,2.25,1.46,4.7,1.46,1.44,0,2.63-.21,3.57-.64,.94-.43,1.51-1.07,1.7-1.93,.17-.82-.04-1.45-.64-1.87-.6-.43-2.99-1.16-7.17-2.21-3-.79-5.02-1.77-6.06-2.95-1.06-1.16-1.35-2.84-.87-5.03,.55-2.59,2.03-4.81,4.46-6.66,2.42-1.86,5.47-2.79,9.16-2.79s6.19,.7,8.09,2.09c1.9,1.4,2.65,3.81,2.26,7.23h-7.32c.09-.94-.02-1.69-.33-2.23-.6-.99-1.87-1.49-3.8-1.49-1.59,0-2.78,.25-3.56,.74-.78,.5-1.24,1.08-1.37,1.75-.19,.84,.04,1.45,.69,1.82,.63,.39,3.03,1.07,7.19,2.03,2.76,.69,4.72,1.72,5.88,3.11,1.15,1.4,1.5,3.16,1.05,5.26-.6,2.77-2.11,5.04-4.55,6.79-2.43,1.76-5.8,2.63-10.12,2.63s-7.45-.93-9.16-2.79c-1.7-1.86-2.26-4.22-1.66-7.1h7.42Z"/><text class="c3" x="406" y="52" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" font-size="21" font-weight="400" letter-spacing="0.5">Group</text><polygon class="c1" points="53.4 30.35 53.4 22.29 31.41 8.51 8.87 22.26 8.87 34.53 45.59 42.34 45.59 52.83 38.55 52.83 31.39 45.47 24.15 52.83 16.68 52.83 16.68 39 8.87 37.4 8.87 60.64 27.43 60.64 31.36 56.65 35.25 60.64 53.4 60.64 53.4 36.01 16.68 28.21 16.68 26.65 31.35 17.69 45.59 26.61 45.59 31.95 53.4 33.41 53.4 30.35"/><rect fill="#F15A29" x="8.96" y="62.99" width="44.53" height="7.77"/></svg>';

  // ── Logo PNG Cache & Renderer ──
  let _logoCache = null;

  function getLogoPNG() {
    return new Promise(function(resolve) {
      if (_logoCache) { resolve(_logoCache); return; }
      var canvas = document.createElement('canvas');
      canvas.width = 490; canvas.height = 80;
      var ctx = canvas.getContext('2d');
      var img = new Image();
      var blob = new Blob([SW_LOGO_WHITE], { type: 'image/svg+xml' });
      var url = URL.createObjectURL(blob);
      img.onload = function() {
        ctx.drawImage(img, 0, 0, 490, 80);
        _logoCache = canvas.toDataURL('image/png');
        URL.revokeObjectURL(url);
        resolve(_logoCache);
      };
      img.onerror = function() { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  // ── PDF Helper Functions ──
  // These match the patterns used in both fencing and patio tools

  var pdfHelpers = {
    // Format currency
    fmt: function(n) {
      return (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    // Standard header band: orange accent → dark blue band → logo
    header: function(doc, logoPng, title, subtitle) {
      // Orange accent bar (3mm)
      doc.setFillColor.apply(doc, SW_ORANGE);
      doc.rect(0, 0, PDF_W, 3, 'F');

      // Dark blue header band (18mm)
      doc.setFillColor.apply(doc, SW_DARK);
      doc.rect(0, 3, PDF_W, 18, 'F');

      // Logo (if available)
      if (logoPng) {
        var logoW = 60;
        var logoH = logoW * (80 / 490);
        doc.addImage(logoPng, 'PNG', PDF_M, 5.5, logoW, logoH);
      }

      // Title below band
      var y = 28;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor.apply(doc, SW_DARK);
      doc.text(title || '', PDF_M, y);

      // Orange accent rule under title
      doc.setDrawColor.apply(doc, SW_ORANGE);
      doc.setLineWidth(0.8);
      var titleW = doc.getTextWidth(title || '');
      doc.line(PDF_M, y + 1.5, PDF_M + titleW, y + 1.5);

      y += 5;

      // Subtitle
      if (subtitle) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor.apply(doc, SW_MID);
        doc.text(subtitle, PDF_M, y);
        y += 4;
      }

      // Company info line
      y += 2;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor.apply(doc, SW_MID);
      doc.text(
        'SecureWorks WA Pty Ltd  |  ABN 64 689 223 416  |  admin@secureworkswa.com.au',
        PDF_W / 2, y, { align: 'center' }
      );

      return y + 6; // return next Y position
    },

    // Section header: dark bar with orange left accent
    sectionHeader: function(doc, y, title) {
      if (y > 265) { doc.addPage(); y = PDF_M; }
      doc.setFillColor.apply(doc, SW_DARK);
      doc.rect(PDF_M, y, PDF_CW, 8, 'F');
      doc.setFillColor.apply(doc, SW_ORANGE);
      doc.rect(PDF_M, y, 2, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(255, 255, 255);
      doc.text(title, PDF_M + 6, y + 5.8);
      return y + 12;
    },

    // Sub-section: bold dark text + orange underline
    subSection: function(doc, y, title) {
      if (y > 272) { doc.addPage(); y = PDF_M; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, SW_DARK);
      doc.text(title, PDF_M, y);
      doc.setDrawColor.apply(doc, SW_ORANGE);
      doc.setLineWidth(0.3);
      var w = doc.getTextWidth(title);
      doc.line(PDF_M, y + 1, PDF_M + w, y + 1);
      doc.setLineWidth(0.2);
      return y + 5;
    },

    // Group label: uppercase, muted
    groupLabel: function(doc, y, label) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor.apply(doc, SW_MID);
      doc.text(label.toUpperCase(), PDF_M, y);
      return y + 4;
    },

    // Label + value pair on one line
    labelValue: function(doc, y, label, value, opts) {
      opts = opts || {};
      var lx = opts.x || PDF_M;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor.apply(doc, SW_MID);
      doc.text(label, lx, y);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, SW_DARK);
      doc.text(String(value || ''), lx + (opts.labelWidth || 45), y);
      return y + 5;
    },

    // Info card (orange left bar + light bg)
    infoCard: function(doc, y, pairs, opts) {
      opts = opts || {};
      var cols = opts.cols || 2;
      var cw = PDF_CW / cols;
      var cardH = Math.ceil(pairs.length / cols) * 7.5 + 4;

      if (y + cardH > 280) { doc.addPage(); y = PDF_M; }

      // Light background
      doc.setFillColor.apply(doc, SW_LIGHT);
      doc.rect(PDF_M, y, PDF_CW, cardH, 'F');
      // Orange left accent
      doc.setFillColor.apply(doc, SW_ORANGE);
      doc.rect(PDF_M, y, 2, cardH, 'F');

      var cy = y + 5;
      pairs.forEach(function(pair, i) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var px = PDF_M + 6 + (col * cw);
        var py = y + 5 + (row * 7.5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor.apply(doc, SW_MID);
        doc.text(pair[0], px, py);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor.apply(doc, SW_DARK);
        doc.text(String(pair[1] || ''), px + 40, py);
      });

      return y + cardH + 4;
    },

    // Footer with page numbers
    footer: function(doc, pageNum, totalPages) {
      var y = PDF_H - 8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor.apply(doc, SW_MUTED);
      doc.text('SecureWorks WA Pty Ltd', PDF_M, y);
      doc.text('Page ' + pageNum + ' of ' + totalPages, PDF_W - PDF_M, y, { align: 'right' });
      // Orange bottom line
      doc.setDrawColor.apply(doc, SW_ORANGE);
      doc.setLineWidth(0.5);
      doc.line(PDF_M, y - 3, PDF_W - PDF_M, y - 3);
    },

    // Add page numbers to all pages
    addPageNumbers: function(doc) {
      var total = doc.internal.getNumberOfPages();
      for (var i = 1; i <= total; i++) {
        doc.setPage(i);
        this.footer(doc, i, total);
      }
    },

    // Check if we need a new page
    checkPage: function(doc, y, needed) {
      if (y + (needed || 20) > 280) {
        doc.addPage();
        return PDF_M;
      }
      return y;
    }
  };

  // ── Export to window ──
  window.SW_BRAND = {
    // Colours (RGB arrays)
    SW_ORANGE: SW_ORANGE,
    SW_DARK: SW_DARK,
    SW_MID: SW_MID,
    SW_LIGHT: SW_LIGHT,
    SW_RULE: SW_RULE,
    SW_BODY: SW_BODY,
    SW_MUTED: SW_MUTED,

    // Hex colours
    HEX: SW_HEX,

    // Logo
    SW_LOGO_WHITE: SW_LOGO_WHITE,
    getLogoPNG: getLogoPNG,

    // PDF helpers
    pdf: pdfHelpers,

    // PDF layout constants
    PDF_M: PDF_M,
    PDF_W: PDF_W,
    PDF_H: PDF_H,
    PDF_CW: PDF_CW
  };

})();
