// ════════════════════════════════════════════════════════════
// SecureWorks — Shared Media Module
// Photo/video capture, compression, thumbnail generation
// Works standalone (base64) or with cloud.js (uploads to Supabase)
//
// Usage:
//   <script src="../shared/media.js"></script>
//   var mediaManager = SW_MEDIA.create({ jobId: '...', phase: 'scope' });
// ════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // ── Compression defaults ──
  var PHOTO_MAX_SIZE_MB = 1;
  var PHOTO_MAX_WIDTH = 1920;
  var THUMB_WIDTH = 200;
  var VIDEO_MAX_SIZE_MB = 50;

  // ── Photo Labels ──
  var DEFAULT_LABELS = [
    'Front of property',
    'Rear of property',
    'Existing structure',
    'Fence line',
    'Boundary peg',
    'Retaining',
    'Services (gas/water/power)',
    'Access point',
    'Attachment point',
    'Fascia/wall detail',
    'Measurement',
    'Ground level',
    'Slope/fall',
    'Neighbour side',
    'Other'
  ];

  // ════════════════════════════════════════════════════════════
  // MEDIA MANAGER FACTORY
  // ════════════════════════════════════════════════════════════

  function create(opts) {
    opts = opts || {};
    var jobId = opts.jobId || null;
    var phase = opts.phase || 'scope';
    var containerId = opts.containerId || 'scopeMediaContainer';
    var cloud = window.SECUREWORKS_CLOUD;

    // ── State ──
    var photos = [];
    var video = null;
    var _listeners = {};

    function emit(event, data) {
      (_listeners[event] || []).forEach(function(fn) { fn(data); });
    }

    // ════════════════════════════════════════════════════
    // PHOTO HANDLING
    // ════════════════════════════════════════════════════

    async function handlePhotoFiles(fileList) {
      for (var i = 0; i < fileList.length; i++) {
        var file = fileList[i];
        if (!file.type.startsWith('image/')) continue;

        try {
          // Compress
          var compressed = await _compressPhoto(file);

          // Generate local data URL for immediate display
          var dataUrl = await _fileToDataUrl(compressed);

          // Generate thumbnail locally
          var thumbDataUrl = await _generateLocalThumbnail(dataUrl, THUMB_WIDTH);

          var photo = {
            id: crypto.randomUUID(),
            dataUrl: dataUrl,
            thumbnailUrl: thumbDataUrl,
            cloudUrl: null,
            cloudThumbUrl: null,
            label: '',
            notes: '',
            uploading: false,
            uploaded: false,
            file: compressed
          };

          photos.push(photo);
          _render();
          emit('photo:added', photo);

          // Upload to cloud if available
          if (cloud && jobId) {
            photo.uploading = true;
            _render();
            try {
              var result = await cloud.media.uploadPhoto(jobId, compressed, {
                phase: phase,
                label: photo.label
              });
              photo.cloudUrl = result.storage_url;
              photo.cloudThumbUrl = result.thumbnail_url;
              photo.cloudId = result.id;
              photo.uploaded = true;
              photo.uploading = false;
              _render();
              emit('photo:uploaded', photo);
            } catch(e) {
              console.warn('[Media] Upload failed, keeping local:', e);
              photo.uploading = false;
              _render();
            }
          }
        } catch(e) {
          console.error('[Media] Failed to process photo:', e);
        }
      }
    }

    async function deletePhoto(index) {
      var photo = photos[index];
      if (!photo) return;

      // Delete from cloud if uploaded
      if (photo.cloudId && cloud) {
        try {
          await cloud.media.deleteMedia(photo.cloudId);
        } catch(e) {
          console.warn('[Media] Cloud delete failed:', e);
        }
      }

      photos.splice(index, 1);
      _render();
      emit('photo:deleted', { index: index });
    }

    function setPhotoLabel(index, label) {
      if (photos[index]) {
        photos[index].label = label;
        emit('photo:updated', photos[index]);
      }
    }

    // ════════════════════════════════════════════════════
    // VIDEO HANDLING
    // ════════════════════════════════════════════════════

    async function handleVideoFile(fileList) {
      if (!fileList || fileList.length === 0) return;
      var file = fileList[0];
      if (!file.type.startsWith('video/')) return;

      // Check size
      if (file.size > VIDEO_MAX_SIZE_MB * 1024 * 1024) {
        alert('Video too large. Maximum size: ' + VIDEO_MAX_SIZE_MB + 'MB');
        return;
      }

      var objectUrl = URL.createObjectURL(file);
      video = {
        id: crypto.randomUUID(),
        objectUrl: objectUrl,
        cloudUrl: null,
        cloudId: null,
        file: file,
        uploading: false,
        uploaded: false
      };

      _render();
      emit('video:added', video);

      // Upload to cloud
      if (cloud && jobId) {
        video.uploading = true;
        _render();
        try {
          var result = await cloud.media.uploadVideo(jobId, file, { phase: phase });
          video.cloudUrl = result.storage_url;
          video.cloudId = result.id;
          video.uploaded = true;
          video.uploading = false;
          _render();
          emit('video:uploaded', video);
        } catch(e) {
          console.warn('[Media] Video upload failed:', e);
          video.uploading = false;
          _render();
        }
      }
    }

    function deleteVideo() {
      if (!video) return;
      if (video.objectUrl) URL.revokeObjectURL(video.objectUrl);
      if (video.cloudId && cloud) {
        cloud.media.deleteMedia(video.cloudId).catch(function() {});
      }
      video = null;
      _render();
      emit('video:deleted');
    }

    // ════════════════════════════════════════════════════
    // LOAD FROM CLOUD
    // ════════════════════════════════════════════════════

    async function loadFromCloud(loadJobId) {
      if (!cloud) return;
      jobId = loadJobId || jobId;
      if (!jobId) return;

      try {
        var items = await cloud.media.listMedia(jobId, phase);
        photos = [];
        video = null;

        items.forEach(function(item) {
          if (item.type === 'photo') {
            photos.push({
              id: item.id,
              dataUrl: item.storage_url, // Use cloud URL for display
              thumbnailUrl: item.thumbnail_url || item.storage_url,
              cloudUrl: item.storage_url,
              cloudThumbUrl: item.thumbnail_url,
              cloudId: item.id,
              label: item.label || '',
              notes: item.notes || '',
              uploading: false,
              uploaded: true,
              file: null
            });
          } else if (item.type === 'video') {
            video = {
              id: item.id,
              objectUrl: item.storage_url,
              cloudUrl: item.storage_url,
              cloudId: item.id,
              uploading: false,
              uploaded: true,
              file: null
            };
          }
        });

        _render();
        emit('media:loaded', { photos: photos.length, hasVideo: !!video });
      } catch(e) {
        console.warn('[Media] Failed to load from cloud:', e);
      }
    }

    // ════════════════════════════════════════════════════
    // DATA EXPORT (for scope_json / PDF generation)
    // ════════════════════════════════════════════════════

    function getSummary() {
      return {
        photos: photos.map(function(p) {
          return {
            id: p.id,
            url: p.cloudUrl || p.dataUrl,
            thumbnailUrl: p.cloudThumbUrl || p.thumbnailUrl,
            label: p.label,
            notes: p.notes,
            uploaded: p.uploaded
          };
        }),
        video: video ? {
          id: video.id,
          url: video.cloudUrl || video.objectUrl,
          uploaded: video.uploaded
        } : null,
        photoCount: photos.length,
        hasVideo: !!video
      };
    }

    // Get photo data URLs for PDF embedding
    // Returns array of { dataUrl, label } — fetches from cloud if needed
    async function getPhotosForPDF() {
      var result = [];
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
        // If we have a local dataUrl, use it
        if (p.dataUrl && p.dataUrl.startsWith('data:')) {
          result.push({ dataUrl: p.dataUrl, label: p.label });
        }
        // If cloud URL, fetch and convert to data URL
        else if (p.cloudUrl) {
          try {
            var response = await fetch(p.cloudUrl);
            var blob = await response.blob();
            var dataUrl = await _fileToDataUrl(blob);
            result.push({ dataUrl: dataUrl, label: p.label });
          } catch(e) {
            console.warn('[Media] Failed to fetch photo for PDF:', e);
          }
        }
      }
      return result;
    }

    // ════════════════════════════════════════════════════
    // RENDERING
    // ════════════════════════════════════════════════════

    function _render() {
      var container = document.getElementById(containerId);
      if (!container) return;

      var html = '';

      // Photo grid
      if (photos.length > 0) {
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-bottom:12px;">';
        photos.forEach(function(p, i) {
          var imgSrc = p.thumbnailUrl || p.dataUrl;
          var statusBadge = '';
          if (p.uploading) {
            statusBadge = '<div style="position:absolute;top:4px;right:4px;width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:sw-spin 0.8s linear infinite;"></div>';
          } else if (p.uploaded) {
            statusBadge = '<div style="position:absolute;top:4px;right:4px;font-size:12px;">&#9989;</div>';
          }

          html += '<div style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;border:1px solid #eee;">' +
            '<img src="' + imgSrc + '" style="width:100%;height:100%;object-fit:cover;" onclick="this._swMedia && this._swMedia.openLightbox(' + i + ')">' +
            statusBadge +
            '<button onclick="window._swMedia_' + containerId + '.deletePhoto(' + i + ')" style="position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.5);color:#fff;border:none;font-size:14px;line-height:1;cursor:pointer;">&times;</button>' +
            '<select onchange="window._swMedia_' + containerId + '.setPhotoLabel(' + i + ',this.value)" style="position:absolute;bottom:0;left:0;right:0;padding:4px;font-size:10px;border:none;background:rgba(255,255,255,0.9);border-top:1px solid #eee;">' +
              '<option value="">Label...</option>' +
              DEFAULT_LABELS.map(function(l) {
                return '<option value="' + l + '"' + (p.label === l ? ' selected' : '') + '>' + l + '</option>';
              }).join('') +
            '</select>' +
          '</div>';
        });
        html += '</div>';
      }

      // Video
      if (video) {
        var vidSrc = video.objectUrl || video.cloudUrl;
        html += '<div style="position:relative;border-radius:8px;overflow:hidden;border:1px solid #eee;margin-bottom:12px;">' +
          '<video src="' + vidSrc + '" controls style="width:100%;max-height:200px;"></video>' +
          (video.uploading ? '<div style="position:absolute;top:8px;right:8px;padding:4px 8px;background:rgba(0,0,0,0.6);color:#fff;border-radius:12px;font-size:11px;">Uploading...</div>' : '') +
          (video.uploaded ? '<div style="position:absolute;top:8px;right:8px;font-size:14px;">&#9989;</div>' : '') +
          '<button onclick="window._swMedia_' + containerId + '.deleteVideo()" style="position:absolute;top:8px;left:8px;padding:4px 10px;background:rgba(255,0,0,0.7);color:#fff;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Delete</button>' +
        '</div>';
      }

      // Capture buttons
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button onclick="document.getElementById(\'' + containerId + '_photoInput\').click()" style="padding:8px 14px;background:#F15A29;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">&#128247; Take Photo</button>' +
        '<button onclick="document.getElementById(\'' + containerId + '_libraryInput\').click()" style="padding:8px 14px;background:#293C46;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">&#128193; From Library</button>' +
        '<button onclick="document.getElementById(\'' + containerId + '_videoInput\').click()" style="padding:8px 14px;background:#4C6A7C;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">&#127909; Video</button>' +
      '</div>';

      // Hidden file inputs
      html += '<input type="file" id="' + containerId + '_photoInput" accept="image/*" capture="environment" multiple style="display:none" onchange="window._swMedia_' + containerId + '.handlePhotoFiles(this.files);this.value=\'\';">';
      html += '<input type="file" id="' + containerId + '_libraryInput" accept="image/*" multiple style="display:none" onchange="window._swMedia_' + containerId + '.handlePhotoFiles(this.files);this.value=\'\';">';
      html += '<input type="file" id="' + containerId + '_videoInput" accept="video/*" style="display:none" onchange="window._swMedia_' + containerId + '.handleVideoFile(this.files);this.value=\'\';">';

      container.innerHTML = html;
    }

    // Lightbox
    var _lbIndex = 0;
    function openLightbox(index) {
      _lbIndex = index;
      var p = photos[index];
      if (!p) return;

      var overlay = document.createElement('div');
      overlay.id = 'sw-lightbox';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:10000;display:flex;align-items:center;justify-content:center;';
      overlay.innerHTML = '<img src="' + (p.dataUrl || p.cloudUrl) + '" style="max-width:90%;max-height:90%;object-fit:contain;">' +
        '<button onclick="this.parentElement.remove()" style="position:absolute;top:16px;right:16px;background:none;border:none;color:#fff;font-size:32px;cursor:pointer;">&times;</button>' +
        '<button onclick="window._swMedia_' + containerId + '.navLightbox(-1)" style="position:absolute;left:16px;top:50%;transform:translateY(-50%);background:none;border:none;color:#fff;font-size:48px;cursor:pointer;">&lsaquo;</button>' +
        '<button onclick="window._swMedia_' + containerId + '.navLightbox(1)" style="position:absolute;right:16px;top:50%;transform:translateY(-50%);background:none;border:none;color:#fff;font-size:48px;cursor:pointer;">&rsaquo;</button>';
      document.body.appendChild(overlay);
    }

    function navLightbox(dir) {
      _lbIndex = (_lbIndex + dir + photos.length) % photos.length;
      var lb = document.getElementById('sw-lightbox');
      if (lb && photos[_lbIndex]) {
        lb.querySelector('img').src = photos[_lbIndex].dataUrl || photos[_lbIndex].cloudUrl;
      }
    }

    function closeLightbox() {
      var lb = document.getElementById('sw-lightbox');
      if (lb) lb.remove();
    }

    // ════════════════════════════════════════════════════
    // COMPRESSION UTILITIES
    // ════════════════════════════════════════════════════

    function _compressPhoto(file) {
      // Use browser-image-compression if available
      if (window.imageCompression) {
        return window.imageCompression(file, {
          maxSizeMB: PHOTO_MAX_SIZE_MB,
          maxWidthOrHeight: PHOTO_MAX_WIDTH,
          useWebWorker: true
        });
      }
      // Fallback: canvas-based compression
      return new Promise(function(resolve) {
        var reader = new FileReader();
        reader.onload = function(e) {
          var img = new Image();
          img.onload = function() {
            var canvas = document.createElement('canvas');
            var scale = Math.min(1, PHOTO_MAX_WIDTH / Math.max(img.width, img.height));
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function(blob) {
              resolve(blob || file);
            }, 'image/jpeg', 0.8);
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    function _fileToDataUrl(fileOrBlob) {
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function(e) { resolve(e.target.result); };
        reader.onerror = reject;
        reader.readAsDataURL(fileOrBlob);
      });
    }

    function _generateLocalThumbnail(dataUrl, maxWidth) {
      return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() {
          var scale = maxWidth / img.width;
          var canvas = document.createElement('canvas');
          canvas.width = maxWidth;
          canvas.height = img.height * scale;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = function() { resolve(dataUrl); };
        img.src = dataUrl;
      });
    }

    // ── Expose on window for onclick handlers ──
    var manager = {
      handlePhotoFiles: handlePhotoFiles,
      handleVideoFile: handleVideoFile,
      deletePhoto: deletePhoto,
      deleteVideo: deleteVideo,
      setPhotoLabel: setPhotoLabel,
      openLightbox: openLightbox,
      navLightbox: navLightbox,
      closeLightbox: closeLightbox,
      loadFromCloud: loadFromCloud,
      getSummary: getSummary,
      getPhotosForPDF: getPhotosForPDF,
      getPhotos: function() { return photos; },
      getVideo: function() { return video; },
      render: _render,
      setJobId: function(id) { jobId = id; },
      setPhase: function(p) { phase = p; },
      on: function(event, fn) { if (!_listeners[event]) _listeners[event] = []; _listeners[event].push(fn); }
    };

    // Expose globally for inline onclick handlers
    window['_swMedia_' + containerId] = manager;

    return manager;
  }

  // ── CSS animation for upload spinner ──
  if (!document.getElementById('sw-media-styles')) {
    var style = document.createElement('style');
    style.id = 'sw-media-styles';
    style.textContent = '@keyframes sw-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  // ── Export ──
  window.SW_MEDIA = {
    create: create,
    LABELS: DEFAULT_LABELS
  };

})();
