// ════════════════════════════════════════════════════════════
// SecureWorks — Tool Integration Layer
//
// Drop this into any scoping tool to add cloud features:
//   - Login / auth
//   - Save to cloud / load from cloud
//   - Job picker
//   - Auto-save
//   - Online/offline indicator
//
// Detects tool type from the page title or a data attribute.
// Requires cloud.js to be loaded first.
//
// Usage (add before </body> in any tool):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script>
//     window.SUPABASE_URL = 'https://kevgrhcjxspbxgovpmfl.supabase.co';
//     window.SUPABASE_ANON_KEY = 'eyJ...';
//   </script>
//   <script src="../shared/brand.js"></script>
//   <script src="../shared/cloud.js"></script>
//   <script src="../shared/integration.js"></script>
// ════════════════════════════════════════════════════════════

(function() {
  'use strict';

  console.log('[Integration] Script loaded');

  var cloud = null;
  var _jobId = null;
  var _lastJobNumber = null;
  var _ghlOpportunityId = null;
  var _ghlContactId = null;
  var _toolType = null;
  var _getStateFn = null;
  var _loadStateFn = null;
  var _jobLoaded = false;

  // Pre-fill all contact fields in the tool from a GHL contact object
  function _prefillContact(contact) {
    if (!contact) return;
    console.log('[Integration] Pre-filling contact:', contact);

    // Build full address string from parts
    var fullAddress = [contact.address, contact.suburb, contact.state, contact.postcode].filter(Boolean).join(', ');

    // Set individual fields — these selectors cover both patio and fencing tools
    var mapping = [
      { val: contact.name, selectors: '#customerName, #clientName, #client, [name="clientName"]' },
      { val: contact.email, selectors: '#clientEmail, #customerEmail, [name="clientEmail"], [name="email"]' },
      { val: contact.phone, selectors: '#customerPhone, #clientPhone, [name="clientPhone"], [name="phone"]' },
      { val: fullAddress, selectors: '#customerAddress, #clientAddress, #siteAddress, #address, [name="siteAddress"], [name="address"]' }
    ];

    mapping.forEach(function(m) {
      if (!m.val) return;
      document.querySelectorAll(m.selectors).forEach(function(el) {
        el.value = m.val;
        // Trigger input event so the tool picks up the change
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    // Also set window globals if the tool uses them
    if (typeof window.customer === 'object' && window.customer) {
      if (contact.name) window.customer.name = contact.name;
      if (contact.phone) window.customer.phone = contact.phone;
      if (contact.email) window.customer.email = contact.email;
      if (fullAddress) window.customer.address = fullAddress;
    }
  }

  // Load photos/videos from Supabase Storage into the tool's sitePhotos/siteVideo arrays
  async function _loadCloudMedia(jobId) {
    if (!cloud) return;
    var media = await cloud.ghl.listMedia(jobId);
    if (!media || media.length === 0) {
      console.log('[Integration] No cloud media for this job');
      return;
    }

    console.log('[Integration] Loading', media.length, 'media items from cloud');

    var photos = media.filter(function(m) { return m.type === 'photo'; });
    var videos = media.filter(function(m) { return m.type === 'video'; });

    // Inject photos into the tool's sitePhotos array
    if (photos.length > 0 && typeof window.sitePhotos !== 'undefined') {
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
        // Use numeric IDs (tool's deletePhoto/updatePhotoLabel expect numbers in onclick)
        var numericId = Date.now() + i;
        window.sitePhotos.push({
          id: numericId,
          cloudId: p.id,             // Keep the database UUID separately
          dataUrl: p.storage_url,    // Use cloud URL instead of base64
          cloudUrl: p.storage_url,   // Mark as already uploaded
          label: p.label || 'Photo',
          caption: p.notes || '',
          originalSize: 0,
          compressedSize: 0
        });
      }
      // Re-render the photo grid if the function exists
      if (typeof window.renderPhotoGrid === 'function') window.renderPhotoGrid();
      if (typeof window.updatePhotoCount === 'function') window.updatePhotoCount();
      console.log('[Integration] Loaded', photos.length, 'photos from cloud');
    }

    // Inject video if present
    if (videos.length > 0 && videos[0].storage_url) {
      var v = videos[0];
      window.siteVideo = {
        objectUrl: v.storage_url,
        cloudUrl: v.storage_url,
        label: v.label || 'Site Walkthrough',
        originalSize: 0,
        file: null  // No file object for cloud videos
      };
      if (typeof window.renderVideoPreview === 'function') window.renderVideoPreview();
      if (typeof window.updateVideoBadge === 'function') window.updateVideoBadge();
      console.log('[Integration] Loaded video from cloud');
    }
  }

  // ── Detect tool type ──
  function detectToolType() {
    var attr = document.body.dataset.toolType || document.documentElement.dataset.toolType;
    if (attr) return attr;
    var title = (document.title || '').toLowerCase();
    if (title.includes('fence') || title.includes('fencing')) return 'fencing';
    if (title.includes('patio')) return 'patio';
    return 'patio';
  }

  // ── Check URL for jobId parameter ──
  function getJobIdFromURL() {
    var params = new URLSearchParams(window.location.search);
    return params.get('jobId') || params.get('job') || null;
  }

  // ── Inject cloud bar below the header ──
  function injectToolbar() {
    var header = document.querySelector('.header') ||
                 document.querySelector('header') ||
                 document.querySelector('[class*="header"]');

    console.log('[Integration] Header found:', !!header);
    if (!header) return;

    // Inject a <style> block for cloud bar + hover states
    if (!document.getElementById('sw-cloud-styles')) {
      var style = document.createElement('style');
      style.id = 'sw-cloud-styles';
      style.textContent =
        '#sw-cloud-bar{display:flex;gap:6px;align-items:center;justify-content:flex-end;' +
          'padding:4px 24px;background:#293C46;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;' +
          'border-bottom:2px solid #F15A29;}' +
        '#sw-cloud-bar .sw-status{font-size:11px;color:rgba(255,255,255,0.6);margin-right:auto;letter-spacing:0.3px;}' +
        '#sw-cloud-bar .sw-btn{padding:3px 12px;border:1px solid rgba(255,255,255,0.25);color:#fff;' +
          'background:transparent;border-radius:3px;font-size:11px;font-weight:600;cursor:pointer;' +
          'letter-spacing:0.3px;transition:all 0.15s ease;text-transform:uppercase;}' +
        '#sw-cloud-bar .sw-btn:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.4);}' +
        '#sw-cloud-bar .sw-btn-primary{background:#F15A29;border-color:#F15A29;}' +
        '#sw-cloud-bar .sw-btn-primary:hover{background:#d94d20;border-color:#d94d20;}' +
        '#sw-cloud-bar .sw-btn-save{background:#34C759;border-color:#34C759;}' +
        '#sw-cloud-bar .sw-btn-save:hover{background:#2ab348;}';
      document.head.appendChild(style);
    }

    // Create a dedicated cloud bar that sits below the header
    var cloudBar = document.createElement('div');
    cloudBar.id = 'sw-cloud-bar';

    cloudBar.innerHTML =
      '<span class="sw-status" id="sw-cloud-status"></span>' +
      '<button id="sw-btn-login" class="sw-btn sw-btn-primary" onclick="window._swIntegration.login()" style="display:none;">Sign In</button>' +
      '<button id="sw-btn-save" class="sw-btn sw-btn-save" onclick="window._swIntegration.save()" style="display:none;">Save</button>' +
      '<button id="sw-btn-load" class="sw-btn" onclick="window._swIntegration.loadPicker()" style="display:none;">Load Job</button>' +
      '<button id="sw-btn-dashboard" class="sw-btn" onclick="window._swIntegration.openDashboard()" style="display:none;">Dashboard</button>';

    // Insert right after the header
    if (header.nextSibling) {
      header.parentNode.insertBefore(cloudBar, header.nextSibling);
    } else {
      header.parentNode.appendChild(cloudBar);
    }

    console.log('[Integration] Cloud bar injected');
  }

  // ── Update UI based on auth state ──
  function updateUI() {
    var loginBtn = document.getElementById('sw-btn-login');
    var saveBtn = document.getElementById('sw-btn-save');
    var loadBtn = document.getElementById('sw-btn-load');
    var dashBtn = document.getElementById('sw-btn-dashboard');
    var status = document.getElementById('sw-cloud-status');

    if (!loginBtn) {
      console.warn('[Integration] updateUI: buttons not found in DOM');
      return;
    }

    if (cloud && cloud.auth.isLoggedIn()) {
      var user = cloud.auth.getUser();
      var userName = (user && user.name) || (user && user.email) || '';
      loginBtn.style.display = 'none';
      saveBtn.style.display = '';
      loadBtn.style.display = '';
      dashBtn.style.display = '';
      if (_lastJobNumber) {
        status.innerHTML = '<strong style="color:#fff;font-size:13px;letter-spacing:0.5px;">' + _lastJobNumber + '</strong> <span style="opacity:0.5;margin:0 4px;">|</span> ' + userName;
      } else if (_jobId) {
        status.textContent = userName + ' | Draft (no job number yet)';
      } else {
        status.textContent = userName;
      }
      console.log('[Integration] UI updated: logged in as', userName);
    } else if (cloud) {
      loginBtn.style.display = '';
      saveBtn.style.display = 'none';
      loadBtn.style.display = 'none';
      dashBtn.style.display = 'none';
      status.textContent = 'Not signed in';
      console.log('[Integration] UI updated: not signed in, showing Sign In button');
    } else {
      loginBtn.style.display = 'none';
      saveBtn.style.display = 'none';
      loadBtn.style.display = 'none';
      dashBtn.style.display = 'none';
      status.textContent = '';
      console.log('[Integration] UI updated: no cloud module');
    }
  }

  // ════════════════════════════════════════════════════════════
  // JOB NUMBER — set the Job Ref field + header badge to the
  // Supabase job number so it's the single source of truth
  // across the tool, PDFs, and all downstream systems.
  // ════════════════════════════════════════════════════════════

  function _applyJobNumber(jobNumber) {
    if (!jobNumber) return;
    // Set the Job Ref input field (used by PDFs, exports, QA)
    var refEl = document.getElementById('jobRef');
    if (refEl) refEl.value = jobNumber;
    // Update header badge if the tool has one
    if (typeof window.updateHeaderBadge === 'function') {
      window.updateHeaderBadge();
    } else {
      // Fencing tool or tools without updateHeaderBadge
      var badge = document.getElementById('headerBadge');
      var name = (document.getElementById('customerName') || document.getElementById('clientName') || {}).value || '';
      if (badge) badge.innerHTML = '<strong>' + jobNumber + '</strong>' + (name ? ' &nbsp;' + name : '');
    }
    console.log('[Integration] Job number applied to UI:', jobNumber);
  }

  // ════════════════════════════════════════════════════════════
  // STATE GETTERS / SETTERS  (tool-specific)
  // ════════════════════════════════════════════════════════════

  function getFencingState() {
    if (window.app && window.app.job) {
      return {
        tool: 'fencing',
        version: '1.0',
        job: window.app.job,
        scopeMedia: window.scopeMedia ? {
          photos: (window.scopeMedia.photos || []).map(function(p) {
            return { label: p.label, dataUrl: p.dataUrl };
          }),
          video: window.scopeMedia.video || null
        } : null,
        savedAt: new Date().toISOString()
      };
    }
    return null;
  }

  function loadFencingState(scopeJson) {
    if (!scopeJson || !scopeJson.job || !window.app) return false;
    try {
      window.app.job = scopeJson.job;
      if (window.app.currentRunId && window.app.job.runs.length > 0) {
        window.app.currentRunId = window.app.job.runs[0].id;
      }
      // Sync header inputs (client, address, email, phone, supplier, colour, $/m)
      if (typeof window.app.syncHeaderFromJob === 'function') window.app.syncHeaderFromJob();
      if (typeof window.app.updateProfileDropdown === 'function') window.app.updateProfileDropdown();
      if (typeof window.app.renderAll === 'function') window.app.renderAll();
      else if (typeof window.app.render === 'function') window.app.render();
      return true;
    } catch(e) {
      console.error('[Integration] Failed to load fencing state:', e);
      return false;
    }
  }

  function getPatioState() {
    if (typeof window.gatherJobData === 'function') {
      try {
        var base = window.gatherJobData();
        // Build enhanced pricing_json if the tool exposes buildPricingJson()
        var pricingJson = null;
        if (typeof window.buildPricingJson === 'function') {
          try { pricingJson = window.buildPricingJson(); } catch(e) { console.warn('[Integration] buildPricingJson failed:', e); }
        }
        // Include verification state if available (QA sign-off records)
        var verification = null;
        if (window.patioQA && window.patioQA._verificationState) {
          verification = window.patioQA._verificationState;
        } else {
          // Fallback: read from localStorage
          var jobRef = (document.getElementById('jobRef') || {}).value || '';
          if (jobRef) {
            try { verification = JSON.parse(localStorage.getItem('patio-verification-' + jobRef)); } catch(e) {}
          }
        }
        return {
          tool: 'patio',
          version: '1.0',
          client: base.client,
          config: base.config,
          pricing: base.pricing,
          complexity: base.complexity,
          notes: base.notes,
          customer: window.customer || {},
          siteDetails: window.siteDetails || {},
          _pricing_json: pricingJson,
          verification: verification,
          savedAt: new Date().toISOString()
        };
      } catch(e) {
        console.warn('[Integration] gatherJobData failed:', e);
      }
    }
    if (typeof window.saveJobData === 'function') {
      return { tool: 'patio', version: '1.0', savedAt: new Date().toISOString() };
    }
    return null;
  }

  function loadPatioState(scopeJson) {
    if (!scopeJson) return false;
    try {
      var textarea = document.getElementById('loadJobTextarea');
      if (textarea && typeof window.loadJobData === 'function') {
        textarea.value = JSON.stringify(scopeJson);
        window.loadJobData();
        var modal = document.getElementById('loadJobModal');
        if (modal) modal.style.display = 'none';
        return true;
      }
      return false;
    } catch(e) {
      console.error('[Integration] Failed to load patio state:', e);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API  (exposed on window for button clicks)
  // ════════════════════════════════════════════════════════════

  var integration = {
    login: function() {
      if (cloud) cloud.ui.showLoginModal();
    },

    save: async function() {
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      var state = _getStateFn();
      if (!state) {
        alert('Nothing to save — no job data found.');
        return;
      }

      var meta = {};
      if (state.job) {
        meta.client_name = state.job.clientName || state.job.client || '';
        meta.site_suburb = state.job.suburb || '';
        meta.client_phone = state.job.phone || '';
        meta.client_email = state.job.email || '';
        meta.site_address = state.job.address || '';
      } else if (state.customer || state.client) {
        var c = state.customer || {};
        var cl = state.client || {};
        meta.client_name = c.name || cl.name || '';
        meta.site_suburb = cl.suburb || c.address || '';
        meta.client_phone = c.phone || cl.phone || '';
        meta.client_email = c.email || cl.email || '';
        meta.site_address = c.address || cl.address || '';
      }
      // Fallback: read directly from DOM if meta is empty (covers both patio + fencing IDs)
      if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || document.getElementById('client') || {}).value || '';
      if (!meta.client_phone) meta.client_phone = (document.getElementById('customerPhone') || document.getElementById('clientPhone') || {}).value || '';
      if (!meta.client_email) meta.client_email = (document.getElementById('clientEmail') || {}).value || '';
      if (!meta.site_address) meta.site_address = (document.getElementById('customerAddress') || document.getElementById('address') || {}).value || '';

      // Include pricing_json if the tool attached it to job state or root state
      if (state.job && state.job._pricing_json) {
        meta.pricing_json = state.job._pricing_json;
      } else if (state._pricing_json) {
        meta.pricing_json = state._pricing_json;
      }

      try {
        cloud.ui.showSaveStatus('saving');

        if (!_jobId) {
          // Use DOM fields first, then prompt as last resort
          if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || {}).value || '';
          if (!meta.client_name) meta.client_name = prompt('Client name for this job:');
          if (!meta.client_name) { cloud.ui.showSaveStatus('error'); return; }

          // Create job via edge function (bypasses RLS)
          var contact = { name: meta.client_name, phone: meta.client_phone, email: meta.client_email, address: meta.site_address, suburb: meta.site_suburb };
          var job = await cloud.ghl.createJobForOpportunity(_ghlOpportunityId || '', _toolType, contact);
          _jobId = job.id;

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
        }

        // Save via edge function (bypasses RLS)
        console.log('[Integration] Saving scope for job:', _jobId);
        await cloud.ghl.saveScope(_jobId, state, meta);
        console.log('[Integration] Scope saved successfully');

        // Upload site photos via signed URLs (handles large photos, no size limit)
        var sitePhotos = window.sitePhotos || [];
        var photosToUpload = sitePhotos.filter(function(p) { return !p.cloudUrl && p.dataUrl; });
        if (photosToUpload.length > 0) {
          console.log('[Integration] Uploading', photosToUpload.length, 'photos via signed URLs...');
          cloud.ui.showSaveStatus('saving', 'Uploading photos 0/' + photosToUpload.length);
          for (var i = 0; i < photosToUpload.length; i++) {
            var photo = photosToUpload[i];
            try {
              cloud.ui.showSaveStatus('saving', 'Uploading photo ' + (i + 1) + '/' + photosToUpload.length);

              // Convert dataUrl to Blob for direct upload
              var mimeMatch = photo.dataUrl.match(/data:([^;]+);/);
              var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
              var ext = mime.includes('png') ? 'png' : 'jpg';
              var b64 = photo.dataUrl.split(',')[1];
              var binary = atob(b64);
              var bytes = new Uint8Array(binary.length);
              for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
              var blob = new Blob([bytes], { type: mime });

              // Get signed upload URL
              var urlRes = await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=get_upload_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: _jobId,
                  fileName: (photo.label || 'photo_' + i) + '.' + ext,
                  contentType: mime
                })
              });
              var urlData = await urlRes.json();
              if (!urlRes.ok) throw new Error(urlData.error || 'Failed to get upload URL');

              // Upload directly to Supabase Storage
              var uploadRes = await fetch(urlData.signedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': mime },
                body: blob
              });
              if (!uploadRes.ok) throw new Error('Photo upload failed: ' + uploadRes.status);

              // Register in database
              await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=register_media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: _jobId,
                  storageUrl: urlData.publicUrl,
                  type: 'photo',
                  label: photo.label || 'Photo ' + (i + 1)
                })
              });

              photo.cloudUrl = urlData.publicUrl;
              console.log('[Integration] Photo uploaded:', photo.label, (blob.size / 1024).toFixed(0) + 'KB');
            } catch(photoErr) {
              console.warn('[Integration] Photo upload failed:', photo.label, photoErr);
            }
          }
        }

        // Upload site video via signed URL (handles large files)
        var siteVideo = window.siteVideo || null;
        if (siteVideo && !siteVideo.cloudUrl) {
          // Need either a File object or a dataUrl to upload
          var videoBody = siteVideo.file || null;
          var videoMime = 'video/mp4';
          var videoName = 'video.mp4';

          if (!videoBody && siteVideo.dataUrl) {
            // Convert dataUrl to blob (rare — most videos come as File)
            var vMimeMatch = siteVideo.dataUrl.match(/data:([^;]+);/);
            videoMime = vMimeMatch ? vMimeMatch[1] : 'video/mp4';
            var vB64 = siteVideo.dataUrl.split(',')[1];
            var vBinary = atob(vB64);
            var vBytes = new Uint8Array(vBinary.length);
            for (var k = 0; k < vBinary.length; k++) vBytes[k] = vBinary.charCodeAt(k);
            videoBody = new Blob([vBytes], { type: videoMime });
          }

          if (videoBody) {
            try {
              if (videoBody.name) videoName = videoBody.name;
              if (videoBody.type) videoMime = videoBody.type;
              console.log('[Integration] Uploading video...', videoName, ((videoBody.size || 0) / 1048576).toFixed(1) + 'MB');
              cloud.ui.showSaveStatus('saving', 'Uploading video...');

              var urlRes = await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=get_upload_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: _jobId, fileName: videoName, contentType: videoMime })
              });
              var urlData = await urlRes.json();
              if (!urlRes.ok) throw new Error(urlData.error || 'Failed to get upload URL');

              var uploadRes = await fetch(urlData.signedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': videoMime },
                body: videoBody
              });
              if (!uploadRes.ok) throw new Error('Video upload failed: ' + uploadRes.status);

              await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=register_media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: _jobId,
                  storageUrl: urlData.publicUrl,
                  type: 'video',
                  label: siteVideo.label || 'Site Walkthrough'
                })
              });

              siteVideo.cloudUrl = urlData.publicUrl;
              console.log('[Integration] Video uploaded:', urlData.publicUrl);
            } catch(vidErr) {
              console.warn('[Integration] Video upload failed:', vidErr);
            }
          }
        }

        // Write scope link back to GHL opportunity notes
        if (_ghlOpportunityId) {
          try {
            var linkResult = await cloud.ghl.linkScope(_ghlOpportunityId, _jobId, _toolType, _ghlContactId);
            if (linkResult && linkResult.jobNumber) {
              _lastJobNumber = linkResult.jobNumber;
              console.log('[Integration] Job number assigned:', linkResult.jobNumber);
            }
          } catch(ghlErr) {
            console.warn('[Integration] GHL link failed (non-blocking):', ghlErr);
          }
        }

        // Push contact details back to GHL
        if (_ghlContactId && meta.client_name) {
          try {
            await cloud.ghl.updateContact(_ghlContactId, {
              name: meta.client_name,
              email: meta.client_email || '',
              phone: meta.client_phone || '',
              address: meta.site_address || '',
              suburb: meta.site_suburb || ''
            });
          } catch(ghlErr) {
            console.warn('[Integration] GHL contact update failed (non-blocking):', ghlErr);
          }
        }

        if (_lastJobNumber) {
          cloud.ui.showSaveStatus('saved', 'Saved — ' + _lastJobNumber);
        } else {
          cloud.ui.showSaveStatus('saved');
        }
        updateUI();

      } catch(e) {
        console.error('[Integration] Save failed:', e);
        cloud.ui.showSaveStatus('error');
        alert('Save failed: ' + e.message);
      }
    },

    loadPicker: function() {
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      // Show GHL opportunity picker (primary flow)
      cloud.ui.showGHLPicker(_toolType, async function(opp) {
        console.log('[Integration] GHL opportunity selected:', opp.id, opp.contactName);
        try {
          _ghlOpportunityId = opp.id;
          _ghlContactId = opp.contactId || null;

          // Fetch full contact details from GHL (has address, suburb etc)
          var contact = null;
          if (_ghlContactId) {
            try {
              contact = await cloud.ghl.getContact(_ghlContactId);
              console.log('[Integration] Contact fetched:', contact);
            } catch(e) {
              console.warn('[Integration] Contact fetch failed, using opp data:', e);
              contact = { name: opp.contactName, email: opp.contactEmail, phone: opp.contactPhone };
            }
          } else {
            contact = { name: opp.contactName, email: opp.contactEmail, phone: opp.contactPhone };
          }

          // Check if a Supabase job already exists for this opportunity
          var existingJob = null;
          try {
            existingJob = await cloud.ghl.findJobByOpportunity(opp.id, _toolType);
            console.log('[Integration] Existing job:', existingJob ? existingJob.id : 'none');
          } catch(e) {
            console.warn('[Integration] findJobByOpportunity failed:', e);
          }

          if (existingJob) {
            _jobId = existingJob.id;
            _lastJobNumber = existingJob.job_number || null;
            console.log('[Integration] Found existing job:', _jobId, 'number:', _lastJobNumber);
            if (existingJob.scope_json && Object.keys(existingJob.scope_json).length > 0) {
              _loadStateFn(existingJob.scope_json);
            }
            // Apply job number AFTER loadStateFn so it overrides the local ref
            _applyJobNumber(_lastJobNumber);
            // Load photos/videos from cloud
            try { await _loadCloudMedia(_jobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
          } else {
            // Create a new Supabase job linked to this GHL opportunity (via edge function)
            var contactForJob = contact || { name: opp.contactName, phone: opp.contactPhone, email: opp.contactEmail };
            console.log('[Integration] Creating job for:', contactForJob.name || opp.name);
            var job = await cloud.ghl.createJobForOpportunity(opp.id, _toolType, contactForJob);
            _jobId = job.id;
            console.log('[Integration] Job created:', _jobId);
          }

          // Pre-fill contact fields in the tool
          if (contact) _prefillContact(contact);

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
          console.log('[Integration] Job loaded, URL updated:', newUrl);
          updateUI();
          cloud.startAutoSave(_jobId, _getStateFn, 30000);

        } catch(e) {
          console.error('[Integration] GHL load error:', e);
          alert('Error loading opportunity: ' + e.message);
        }
      });
    },

    // Legacy: load from Supabase job list directly
    loadFromSupabase: function() {
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      cloud.ui.showJobPicker(_toolType, async function(jobId) {
        try {
          var job = await cloud.jobs.loadJob(jobId);
          if (job.scope_json && Object.keys(job.scope_json).length > 0) {
            var loaded = _loadStateFn(job.scope_json);
            if (loaded) {
              _jobId = jobId;
              _ghlOpportunityId = job.ghl_opportunity_id || null;
              var newUrl = window.location.pathname + '?jobId=' + _jobId;
              window.history.replaceState({}, '', newUrl);
              updateUI();
              cloud.ui.showSaveStatus('saved');
              cloud.startAutoSave(_jobId, _getStateFn, 30000);
            } else {
              alert('Failed to load job data into the tool.');
            }
          } else {
            _jobId = jobId;
            _ghlOpportunityId = job.ghl_opportunity_id || null;
            var newUrl = window.location.pathname + '?jobId=' + _jobId;
            window.history.replaceState({}, '', newUrl);
            updateUI();

            if (job.client_name) {
              var nameFields = document.querySelectorAll('#clientName, #customerName, [name="clientName"]');
              nameFields.forEach(function(f) { f.value = job.client_name; });
            }

            cloud.startAutoSave(_jobId, _getStateFn, 30000);
          }
        } catch(e) {
          alert('Error loading job: ' + e.message);
        }
      });
    },

    openDashboard: function() {
      window.location.href = '../dashboard/index.html';
    },

    // ── Cloud save triggered after QA sign-off ──
    // Called automatically by both patio and fencing tools when scope is signed off.
    // Runs validation, saves scope + pricing + verification state to Supabase,
    // uploads photos/video, and links to GHL. Shows progress overlay.
    saveAfterSignOff: async function() {
      if (!cloud) {
        console.warn('[Integration] Cloud not available — sign-off saved locally only');
        return { success: false, reason: 'no_cloud' };
      }
      if (!cloud.auth.isLoggedIn()) {
        console.warn('[Integration] Not logged in — sign-off saved locally only');
        return { success: false, reason: 'not_logged_in' };
      }

      // Skip the validation modal — QA checks are stricter and already passed.
      // But still collect the data to ensure we have what we need.
      var validation = _validateForSave();
      if (!validation.valid) {
        console.warn('[Integration] Validation failed after sign-off:', validation.errors);
        // Don't block — QA already passed. Log but continue.
      }

      try {
        // Run the full save flow (scope, photos, video, GHL link)
        await integration.save();
        console.log('[Integration] Cloud save after sign-off completed');
        return { success: true };
      } catch(e) {
        console.error('[Integration] Cloud save after sign-off failed:', e);
        return { success: false, reason: e.message };
      }
    },

    // Returns the current job ID (used by tools to check if cloud-connected)
    getJobId: function() { return _jobId; },
    getLastJobNumber: function() { return _lastJobNumber; },

    // Returns whether cloud save is available
    isCloudReady: function() {
      return !!(cloud && cloud.auth.isLoggedIn());
    }
  };

  window._swIntegration = integration;

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════

  function init() {
    console.log('[Integration] init() called');
    cloud = window.SECUREWORKS_CLOUD;
    _toolType = detectToolType();
    console.log('[Integration] Tool type:', _toolType, '| Cloud:', !!cloud);

    if (_toolType === 'fencing') {
      _getStateFn = getFencingState;
      _loadStateFn = loadFencingState;
    } else {
      _getStateFn = getPatioState;
      _loadStateFn = loadPatioState;
    }

    injectToolbar();

    if (!cloud) {
      updateUI();
      return;
    }

    cloud.on('auth:login', function() {
      updateUI();
      _autoLoadJob();
    });

    cloud.on('auth:logout', function() {
      _jobId = null;
      _ghlOpportunityId = null;
      _ghlContactId = null;
      cloud.stopAutoSave();
      updateUI();
    });

    cloud.on('autosave:success', function() {
      cloud.ui.showSaveStatus('saved');
    });
    cloud.on('autosave:error', function() {
      cloud.ui.showSaveStatus('error');
    });

    cloud.on('online', function() {
      var el = document.getElementById('sw-cloud-status');
      if (el) el.textContent = el.textContent.replace(' (offline)', '');
    });
    cloud.on('offline', function() {
      var el = document.getElementById('sw-cloud-status');
      if (el && !el.textContent.includes('offline')) {
        el.textContent += ' (offline)';
      }
    });

    updateUI();

    // If already logged in, load job immediately (auth:login won't fire)
    if (cloud.auth.isLoggedIn()) {
      _autoLoadJob();
    }
  }

  // Shared job-load logic — called from auth:login AND isLoggedIn() check.
  // Guard prevents double-load.
  async function _autoLoadJob() {
    var urlJobId = getJobIdFromURL();
    if (!urlJobId || _jobLoaded) return;
    _jobLoaded = true;

    _jobId = urlJobId;
    console.log('[Integration] Auto-loading job:', urlJobId);
    try {
      var job = await cloud.ghl.loadJob(urlJobId);
      if (job.scope_json && Object.keys(job.scope_json).length > 0) {
        _loadStateFn(job.scope_json);
      }
      _ghlOpportunityId = job.ghl_opportunity_id || null;
      _lastJobNumber = job.job_number || null;
      // Apply job number AFTER loadStateFn has finished setting the local ref
      _applyJobNumber(_lastJobNumber);
      try { await _loadCloudMedia(urlJobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
      cloud.startAutoSave(_jobId, _getStateFn, 30000);
      updateUI();
    } catch(e) {
      console.warn('[Integration] Failed to auto-load job:', e);
      _jobLoaded = false; // Allow retry
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 200); });
  } else {
    setTimeout(init, 200);
  }

})();
