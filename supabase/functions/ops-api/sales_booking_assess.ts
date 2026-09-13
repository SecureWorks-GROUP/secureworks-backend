// Canonical Booking assessment engine (TypeScript). Shared by ops-api and the local assess server.
// @ts-nocheck
export const VERSION = 'sales-booking-assess-v2.4';
export const MAX_OBSERVATION_AGE_MS = 72 * 60 * 60 * 1000;
export const INTERPRETER_FALLBACK = 'conservative-fallback';
var TZ_PERTH = 'Australia/Perth';
var MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8,
  sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
};
var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function mondayIso(iso) {
  var parts = String(iso).slice(0, 10).split('-').map(Number);
  var utc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  var day = new Date(utc).getUTCDay();
  var delta = day === 0 ? -6 : 1 - day;
  var m = new Date(utc);
  m.setUTCDate(m.getUTCDate() + delta);
  return m.toISOString().slice(0, 10);
}

function bodyOf(msg) {
  return String((msg && (msg.body || msg.text || msg.subject)) || '');
}

function hasOffset(iso) {
  return /Z$|[+-]\d{2}:\d{2}$/.test(String(iso || ''));
}

export function toInstant(iso) {
  if (!iso) return null;
  var s = String(iso);
  if (hasOffset(s)) {
    var ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    var msPerth = Date.parse(s + '+08:00');
    return Number.isFinite(msPerth) ? msPerth : null;
  }
  return null;
}

function perthParts(ms) {
  var fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ_PERTH,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  var map = {};
  fmt.formatToParts(new Date(ms)).forEach(function (p) { map[p.type] = p.value; });
  return {
    date: map.year + '-' + map.month + '-' + map.day,
    hour: Number(map.hour) + Number(map.minute) / 60
  };
}

function isoPerth(date, hour) {
  var h = Math.floor(hour);
  var min = Math.round((hour - h) * 60);
  if (min === 60) { h += 1; min = 0; }
  var local = date + 'T' + (h < 10 ? '0' : '') + h + ':' + (min < 10 ? '0' : '') + min + ':00';
  return { local: local, instant: toInstant(local) };
}

function sortMessages(messages) {
  return (messages || []).slice().sort(function (a, b) {
    var ia = toInstant(a.timestamp) || 0;
    var ib = toInstant(b.timestamp) || 0;
    if (ia !== ib) return ia - ib;
    return String(a.id || '') < String(b.id || '') ? -1 : 1;
  });
}

function yearFrom(input) {
  var w = String(input.week_start || '').slice(0, 4);
  if (w) return Number(w);
  return 2026;
}

function parseClock(text) {
  var m = String(text).toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!m) return null;
  var h = Number(m[1]);
  var min = m[2] ? Number(m[2]) : 0;
  var ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h + min / 60;
}

function parseExplicitDate(text, year) {
  var t = String(text);
  var iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  var named = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i);
  if (!named) named = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (!named) return null;
  var day, month;
  if (MONTHS[named[1].toLowerCase()] != null) {
    month = MONTHS[named[1].toLowerCase()];
    day = Number(named[2]);
  } else {
    day = Number(named[1]);
    month = MONTHS[named[2].toLowerCase()];
  }
  if (month == null || !day) return null;
  var dt = new Date(Date.UTC(year, month, day));
  return dt.toISOString().slice(0, 10);
}

function weekdayName(text) {
  var lower = String(text).toLowerCase();
  for (var i = 1; i <= 5; i++) {
    if (lower.indexOf(WEEKDAYS[i]) >= 0) return WEEKDAYS[i];
  }
  return null;
}

function negatedCancel(text) {
  return /\b(do not|don't|dont|please do not|please don't|not to)\s+cancel\b/i.test(text);
}

function isUnqualifiedYes(text) {
  var t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (/\b(but|only|except|unless|after|before|if |maybe|might|not sure)\b/.test(t)) return false;
  return /^(yes that works|yes please|yes|yep|yeah|ok|okay|that works|see you( then)?|perfect|confirmed)[.! ]*$/.test(t);
}

function isExplicitCancel(text) {
  if (negatedCancel(text)) return false;
  return /\b(cancel(led)?|call(ed)? it off|not going ahead|can't make( it)?|cannot make( it)?)\b/i.test(text);
}

function isBareNo(text) {
  return /^(no|nope|nah)([.! ]|$)/i.test(String(text || '').trim());
}

function isUnavailability(text) {
  return /\b(unavailable|not available|can't make|cannot make|doesn't work|does not work|won't work|will not work|i am not free)\b/i.test(text);
}

function perthWeekdayName(dateIso) {
  var parts = String(dateIso || '').slice(0, 10).split('-').map(Number);
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  return WEEKDAYS[new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()] || null;
}

function windowHour(iso) {
  var m = String(iso || '').match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 60;
}

function localWindowPoint(iso) {
  var instant = toInstant(iso);
  if (instant != null) {
    var local = perthParts(instant);
    return { date: local.date, hour: local.hour };
  }
  return { date: String(iso || '').slice(0, 10), hour: windowHour(iso) };
}

function windowBounds(w) {
  var start = localWindowPoint(w.start_iso);
  var end = localWindowPoint(w.end_iso);
  return {
    start_date: start.date,
    end_date: end.date,
    start_hour: start.hour,
    end_hour: end.hour
  };
}

function textTimeBounds(text, clock) {
  var bounds = { start: null, end: null, exact: false, time_of_day: null };
  if (/\bafternoons?\b/i.test(text) || /\bafternoon\b/i.test(text)) {
    bounds.start = 13;
    bounds.end = 16.5;
    bounds.time_of_day = 'afternoon';
  } else if (/\bmornings?\b/i.test(text) || /\bmorning\b/i.test(text)) {
    bounds.start = 8;
    bounds.end = 12;
    bounds.time_of_day = 'morning';
  }
  if (clock != null && /\bafter\b/i.test(text)) {
    bounds.start = Math.max(bounds.start == null ? clock : bounds.start, clock);
  } else if (clock != null && /\bbefore\b/i.test(text)) {
    bounds.end = Math.min(bounds.end == null ? clock : bounds.end, clock);
  } else if (clock != null) {
    bounds.start = clock;
    bounds.end = clock + 1;
    bounds.exact = true;
  }
  return bounds;
}

function windowMatchesTextTime(text, w, clock) {
  var span = windowBounds(w);
  if (span.start_hour == null || span.end_hour == null) return true;
  if (span.start_date !== span.end_date) return false;
  var bounds = textTimeBounds(text, clock);
  if (bounds.start != null && span.start_hour < bounds.start - 0.01) return false;
  if (bounds.end != null && span.end_hour > bounds.end + 0.01) return false;
  if (bounds.exact && Math.abs(span.start_hour - clock) > 0.26) return false;
  return true;
}

function textContradictsWindow(text, w, year) {
  if (isExplicitCancel(text) || isBareNo(text)) return true;
  var windowDate = localWindowPoint(w.start_iso).date;
  var windowDay = perthWeekdayName(windowDate);
  var lower = String(text || '').toLowerCase();
  if (isUnavailability(text)) {
    if (windowDay && lower.indexOf(windowDay) >= 0) return true;
    var blocked = parseExplicitDate(text, year);
    if (blocked && blocked === windowDate) return true;
    if (!blocked && !weekdayName(text)) return true;
  }
  var laterDate = parseExplicitDate(text, year);
  if (laterDate && laterDate !== windowDate) return true;
  var laterDay = weekdayName(text);
  if (laterDay && windowDay && laterDay !== windowDay && /\b(instead|now|not|unavailable|rather)\b/i.test(text)) {
    return true;
  }
  var laterClock = parseClock(text);
  if (!windowMatchesTextTime(text, w, laterClock)) return true;
  return false;
}

function laterInboundContradicts(messages, cited, w, year) {
  var citedMs = toInstant(cited && cited.timestamp);
  var citedId = cited && cited.id;
  return sortMessages(messages).some(function (m) {
    if ((m.direction || 'inbound') === 'outbound') return false;
    if (citedId && m.id === citedId) return false;
    var ms = toInstant(m.timestamp);
    if (citedMs != null && ms != null && ms <= citedMs) return false;
    return textContradictsWindow(bodyOf(m), w, year);
  });
}

function groundWindowAgainstText(w, text, year) {
  var windowDate = localWindowPoint(w.start_iso).date;
  var windowDay = perthWeekdayName(windowDate);
  var date = parseExplicitDate(text, year);
  var clock = parseClock(text);
  var dayName = weekdayName(text);
  var afternoonOnly = /\bafternoons?\b/i.test(text) && !date && !dayName;
  var morningOnly = /\bmornings?\b/i.test(text) && !date && !dayName;
  if (isExplicitCancel(text) || isBareNo(text)) {
    return { ok: false, reason: 'cited_inbound_contradicts_window' };
  }
  if (isUnavailability(text) && (!date || date === windowDate) && (!dayName || dayName === windowDay)) {
    return { ok: false, reason: 'cited_inbound_contradicts_window' };
  }
  if (date) {
    if (date !== windowDate) return { ok: false, reason: 'window_date_not_in_cited_text' };
    if (!windowMatchesTextTime(text, w, clock)) return { ok: false, reason: 'window_time_contradicts_cited_text' };
    return { ok: true, customer_date_specified: true, date_source: 'customer' };
  }
  if (dayName) {
    if (windowDay !== dayName) return { ok: false, reason: 'window_weekday_not_in_cited_text' };
    if (!windowMatchesTextTime(text, w, clock)) return { ok: false, reason: 'window_time_contradicts_cited_text' };
    var dayBounds = textTimeBounds(text, clock);
    return {
      ok: true,
      customer_date_specified: false,
      date_source: 'ai_proposed',
      weekday: dayName,
      time_of_day: dayBounds.time_of_day,
      after_hour: dayBounds.start,
      before_hour: dayBounds.end
    };
  }
  if (afternoonOnly) {
    if (!windowMatchesTextTime(text, w, clock)) return { ok: false, reason: 'window_time_contradicts_preference' };
    var afternoonBounds = textTimeBounds(text, clock);
    return {
      ok: true,
      customer_date_specified: false,
      date_source: 'ai_proposed',
      time_of_day: 'afternoon',
      after_hour: afternoonBounds.start,
      before_hour: afternoonBounds.end
    };
  }
  if (morningOnly) {
    if (!windowMatchesTextTime(text, w, clock)) return { ok: false, reason: 'window_time_contradicts_preference' };
    var morningBounds = textTimeBounds(text, clock);
    return {
      ok: true,
      customer_date_specified: false,
      date_source: 'ai_proposed',
      time_of_day: 'morning',
      after_hour: morningBounds.start,
      before_hour: morningBounds.end
    };
  }
  if (clock != null && !date && !dayName) {
    if (!windowMatchesTextTime(text, w, clock)) return { ok: false, reason: 'window_time_contradicts_cited_text' };
    var clockBounds = textTimeBounds(text, clock);
    return {
      ok: true,
      customer_date_specified: false,
      date_source: 'ai_proposed',
      after_hour: clockBounds.start,
      before_hour: clockBounds.end
    };
  }
  return { ok: false, reason: 'window_not_grounded_in_cited_text', unverifiable: true };
}

function messageById(messages, id) {
  if (!id) return null;
  var found = null;
  (messages || []).forEach(function (m) {
    if (m && m.id === id) found = m;
  });
  return found;
}

function observationFresh(iso, nowMs) {
  var t = toInstant(iso);
  if (t == null || nowMs == null) return false;
  return nowMs - t <= MAX_OBSERVATION_AGE_MS && t <= nowMs + 60 * 1000;
}

function occupancyGaps(input) {
  var gaps = [];
  var nowRaw = input.now || input.as_of;
  var nowMs = toInstant(nowRaw);
  if (!nowRaw || nowMs == null) gaps.push('as_of_missing');
  var calAt = input.calendar_retrieved_at || (input.coverage && input.coverage.calendar_retrieved_at) || null;
  if (!calAt) {
    gaps.push('calendar_unobserved');
  } else if (nowMs == null || !observationFresh(calAt, nowMs)) {
    gaps.push('stale_calendar_observation');
  }
  if (!input.leave_retrieved_at) {
    gaps.push('leave_unobserved');
  } else if (nowMs == null || !observationFresh(input.leave_retrieved_at, nowMs)) {
    gaps.push('stale_leave_observation');
  }
  if (!input.travel_retrieved_at) {
    gaps.push('travel_unobserved');
  } else if (nowMs == null || !observationFresh(input.travel_retrieved_at, nowMs)) {
    gaps.push('stale_travel_observation');
  }
  (input.events || []).forEach(function (ev) {
    if (toInstant(ev.start_iso || ev.start) == null || toInstant(ev.end_iso || ev.end) == null) {
      gaps.push('malformed_occupancy');
    }
  });
  (input.leave_intervals || []).forEach(function (iv) {
    if (toInstant(iv.start_iso || iv.start) == null || toInstant(iv.end_iso || iv.end) == null) {
      gaps.push('malformed_leave');
    }
  });
  if (input.coverage) {
    if (input.coverage.leave_state === 'unavailable') gaps.push('leave_unavailable');
    if (input.coverage.travel_state === 'unavailable') gaps.push('travel_unavailable');
    if (input.coverage.leave_roster_complete === false) gaps.push('leave_roster_incomplete');
    if (input.coverage.leave === 'not_read' || input.coverage.leave === false || input.coverage.calendar === false || input.coverage.travel === false || input.coverage.route === false) {
      gaps.push('coverage_flag_not_ready');
    }
    if ((input.coverage.calendar === true || input.coverage.leave === 'read' || input.coverage.travel === true) && !input.calendar_retrieved_at && !input.leave_retrieved_at) {
      gaps.push('boolean_coverage_is_not_interval_proof');
    }
    if (input.coverage.leave_state === 'absent' && input.coverage.leave_roster_complete !== true) {
      gaps.push('absent_leave_requires_complete_roster');
    }
  }
  return gaps;
}

export function coverageReady(input) {
  return occupancyGaps(input).length === 0;
}

function rangeOverlap(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return true;
  return !(aEnd <= bStart || bEnd <= aStart);
}

function busyInstants(events, offers) {
  var out = [];
  (events || []).concat(offers || []).forEach(function (ev) {
    var s = toInstant(ev.start_iso || ev.start);
    var e = toInstant(ev.end_iso || ev.end);
    if (s == null || e == null) {
      out.push({ start: null, end: null, malformed: true, id: ev.event_id || ev.offer_id || null });
      return;
    }
    out.push({ start: s, end: e, id: ev.event_id || ev.offer_id || null });
  });
  return out;
}

function sortedSentOffers(input) {
  return (input.sent_offers || []).slice().filter(function (off) {
    return off && off.send_evidence === 'sent' && off.offer_id && off.slot_revision != null && toInstant(off.sent_at || off.timestamp) != null;
  }).sort(function (a, b) {
    return (toInstant(b.sent_at || b.timestamp) || 0) - (toInstant(a.sent_at || a.timestamp) || 0);
  });
}

function immediatelyPrecedingOutbound(inbound, messages) {
  var sorted = sortMessages(messages);
  var idx = -1;
  sorted.forEach(function (m, i) {
    if (m === inbound || (inbound.id && m.id === inbound.id)) idx = i;
  });
  if (idx < 0) idx = sorted.length;
  for (var i = idx - 1; i >= 0; i--) {
    if ((sorted[i].direction || 'inbound') === 'outbound') return sorted[i];
  }
  return null;
}

function precedingSentOffer(inbound, input, messages) {
  if (!inbound) return null;
  var inboundMs = toInstant(inbound.timestamp);
  if (inboundMs == null) return null;
  var prevOut = immediatelyPrecedingOutbound(inbound, messages);
  if (!prevOut) return null;
  var eligible = sortedSentOffers(input).filter(function (off) {
    var sentMs = toInstant(off.sent_at || off.timestamp);
    if (sentMs >= inboundMs) return false;
    if (!off.message_id || off.message_id !== prevOut.id) return false;
    var msg = messageById(messages, off.message_id);
    if (!msg) return false;
    if ((msg.direction || 'inbound') === 'inbound') return false;
    return true;
  });
  return eligible[0] || null;
}

function verifyCitedOffer(input, claimed, inbound, messages) {
  if (!claimed || !claimed.offer_id || claimed.slot_revision == null) {
    return { ok: false, reason: 'unbound' };
  }
  if (!inbound || !isUnqualifiedYes(bodyOf(inbound))) {
    return { ok: false, reason: 'inbound_is_not_unqualified_yes' };
  }
  var matches = sortedSentOffers(input).filter(function (o) { return o.offer_id === claimed.offer_id; });
  if (matches.length !== 1) return { ok: false, reason: 'offer_not_in_sent_evidence' };
  var offer = matches[0];
  if (String(offer.slot_revision) !== String(claimed.slot_revision)) {
    return { ok: false, reason: 'slot_revision_mismatch' };
  }
  var bound = precedingSentOffer(inbound, input, messages);
  if (!bound || bound.offer_id !== offer.offer_id) {
    return { ok: false, reason: 'not_preceding_sent_offer' };
  }
  if (claimed.message_id) {
    var cited = messageById(messages, claimed.message_id);
    if (!cited || (cited.direction || 'inbound') !== 'inbound') {
      return { ok: false, reason: 'cited_message_not_inbound' };
    }
    if (cited.id !== inbound.id) return { ok: false, reason: 'cited_message_not_latest_inbound' };
  }
  if (claimed.start_iso && offer.start_iso && toInstant(claimed.start_iso) !== toInstant(offer.start_iso)) {
    return { ok: false, reason: 'accepted_slot_mismatch' };
  }
  return { ok: true, offer: offer };
}

export function conservativeExtract(input) {
  var messages = sortMessages(input.messages);
  var inbound = [];
  var outbound = [];
  messages.forEach(function (m) {
    if ((m.direction || 'inbound') === 'outbound') outbound.push(m);
    else inbound.push(m);
  });
  var lastIn = inbound.length ? inbound[inbound.length - 1] : null;
  var review = [];
  var windows = [];
  var facts = {
    date_specified: false,
    weekday: null,
    time_of_day: null,
    after_hour: null,
    before_hour: null,
    clock: null,
    explicit_date: null,
    source_message_id: lastIn && lastIn.id || null
  };
  var replyKind = lastIn ? 'ordinary' : 'none';
  var exact = false;
  var accepted = null;
  var year = yearFrom(input);

  if (lastIn) {
    var text = bodyOf(lastIn);
    if (isExplicitCancel(text)) {
      replyKind = 'cancellation';
    } else if (isUnqualifiedYes(text)) {
      var offer = precedingSentOffer(lastIn, input, messages);
      if (offer && offer.offer_id && offer.slot_revision != null) {
        replyKind = 'acceptance';
        exact = true;
        accepted = {
          offer_id: offer.offer_id,
          slot_revision: offer.slot_revision,
          start_iso: offer.start_iso,
          message_id: lastIn.id || null
        };
      } else {
        replyKind = 'ordinary';
        review.push('Yes is not bound to a preceding sent offer id and slot revision.');
      }
    } else if (isBareNo(text) || (isUnavailability(text) && !parseExplicitDate(text, year) && !weekdayName(text))) {
      replyKind = 'ordinary';
      facts.date_specified = false;
      review.push('Latest inbound is a rejection or unavailability, not a booking window.');
    } else if (/\byes\b/i.test(text) && /\b(but|only|after|before)\b/i.test(text)) {
      replyKind = 'new_availability';
      review.push('Qualified yes is not exact acceptance.');
    }

    var date = parseExplicitDate(text, year);
    var clock = parseClock(text);
    var dayName = weekdayName(text);
    var statedBounds = textTimeBounds(text, clock);
    var afternoonOnly = /\bafternoons?\b/i.test(text) && !date && !dayName;
    var morningOnly = /\bmornings?\b/i.test(text) && !date && !dayName;
    if (afternoonOnly || morningOnly) {
      facts.time_of_day = afternoonOnly ? 'afternoon' : 'morning';
      facts.date_specified = false;
      if (statedBounds.start != null) facts.after_hour = statedBounds.start;
      if (statedBounds.end != null) facts.before_hour = statedBounds.end;
      review.push('Customer date unspecified. Any chosen day is an AI proposal, not a customer-stated date.');
    } else if (date) {
      var hasTimeBounds = statedBounds.start != null || statedBounds.end != null;
      if (hasTimeBounds) {
        var startH = statedBounds.start != null ? statedBounds.start : 8;
        var endH = statedBounds.end != null ? statedBounds.end : 16.5;
        facts.date_specified = true;
        facts.explicit_date = date;
        facts.clock = clock;
        facts.time_of_day = statedBounds.time_of_day || (startH >= 13 ? 'afternoon' : (endH <= 12 ? 'morning' : null));
        if (statedBounds.start != null) facts.after_hour = statedBounds.start;
        if (statedBounds.end != null) facts.before_hour = statedBounds.end;
        var start = isoPerth(date, startH);
        var end = isoPerth(date, endH);
        windows.push({
          start_iso: start.local,
          end_iso: end.local,
          start_instant: start.instant,
          end_instant: end.instant,
          source_message_id: lastIn.id || null,
          explicit_date: true
        });
      } else {
        review.push('Date without a time is not a unique slot.');
      }
    } else if (dayName && !date) {
      facts.date_specified = false;
      facts.clock = clock;
      if (isUnavailability(text)) {
        facts.weekday_excluded = dayName;
        review.push('Customer excluded a weekday. Do not treat it as availability.');
      } else {
        facts.weekday = dayName;
        if (statedBounds.time_of_day) facts.time_of_day = statedBounds.time_of_day;
        if (statedBounds.start != null) facts.after_hour = statedBounds.start;
        if (statedBounds.end != null) facts.before_hour = statedBounds.end;
        review.push('Customer named a weekday without a calendar date. A slot on that weekday is an AI proposal.');
      }
    } else if (!date && !dayName && clock != null) {
      facts.clock = clock;
      facts.date_specified = false;
      if (statedBounds.start != null) facts.after_hour = statedBounds.start;
      if (statedBounds.end != null) facts.before_hour = statedBounds.end;
      review.push('Customer named a time without a date. The chosen day is an AI proposal.');
    }
  }

  outbound.forEach(function () {});

  return {
    interpreter: INTERPRETER_FALLBACK,
    intelligent_automation: false,
    reply_kind: replyKind,
    exact_acceptance: exact,
    accepted_offer: accepted,
    windows: windows,
    customer_facts: facts,
    review_reasons: review,
    source_message_ids: messages.map(function (m) { return m.id || null; }).filter(Boolean)
  };
}

function addDaysIso(iso, n) {
  var parts = String(iso).slice(0, 10).split('-').map(Number);
  var utc = Date.UTC(parts[0], parts[1] - 1, parts[2] + n);
  return new Date(utc).toISOString().slice(0, 10);
}

function proposeCandidate(input, facts) {
  facts = facts || {};
  var weekStart = mondayIso(input.week_start || '2026-09-14');
  var rules = (input.resource && input.resource.desk_rules) || {};
  var busy = busyInstants(input.events, input.pending_offers);
  var days = [];
  if (facts.explicit_date) days = [facts.explicit_date];
  else {
    for (var i = 0; i < 5; i++) days.push(addDaysIso(weekStart, i));
    if (facts.weekday) {
      var want = WEEKDAYS.indexOf(facts.weekday);
      days = days.filter(function (d) {
        var parts = d.split('-').map(Number);
        var dow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
        return dow === want;
      });
    }
    if (facts.weekday_excluded) {
      days = days.filter(function (d) { return perthWeekdayName(d) !== facts.weekday_excluded; });
    }
  }
  var found = null;
  days.forEach(function (date) {
    if (found) return;
    var startH = 8;
    var endH = 16.5;
    if (facts.time_of_day === 'afternoon') { startH = 13; endH = 16.5; }
    else if (facts.time_of_day === 'morning') { startH = 8; endH = 12; }
    if (facts.after_hour != null) startH = Math.max(startH, facts.after_hour);
    if (facts.before_hour != null) endH = Math.min(endH, facts.before_hour);
    if (facts.clock != null && facts.after_hour == null && facts.before_hour == null && facts.time_of_day == null && facts.date_specified) {
      startH = facts.clock;
      endH = facts.clock + 1;
    } else if (facts.clock != null && facts.after_hour == null && facts.before_hour == null && facts.time_of_day == null && !facts.date_specified) {
      startH = facts.clock;
      endH = Math.min(16.5, facts.clock + 2);
    }
    var cursor = isoPerth(date, startH);
    var end = isoPerth(date, endH);
    if (cursor.instant == null || end.instant == null) return;
    var ms = cursor.instant;
    while (ms + 60 * 60 * 1000 <= end.instant + 1) {
      var local = perthParts(ms);
      if (!legalStart(local.hour, rules, local.date, weekStart)) {
        ms += 15 * 60 * 1000;
        continue;
      }
      var slotEnd = ms + 60 * 60 * 1000;
      var clash = busy.some(function (b) {
        if (b.malformed) return true;
        return rangeOverlap(ms, slotEnd, b.start, b.end);
      });
      var candidate = {
        start_iso: isoPerth(local.date, local.hour).local,
        end_iso: isoPerth(local.date, local.hour + 1).local,
        start_instant: ms,
        end_instant: slotEnd,
        date_source: facts.date_specified ? 'customer' : 'ai_proposed',
        customer_date_specified: !!facts.date_specified,
        window_label: facts.date_specified ? 'customer date' : 'AI-proposed date, customer date unspecified'
      };
      if (!clash && slotFeasible(candidate, input)) {
        found = candidate;
        return;
      }
      ms += 15 * 60 * 1000;
    }
  });
  return found;
}

function legalStart(hour, rules, perthDate, weekStart) {
  var parts = perthDate.split('-').map(Number);
  var utc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  var dow = new Date(utc).getUTCDay();
  var dayIndex = dow === 0 ? 6 : dow - 1;
  if (dayIndex > 4) return false;
  if (hour < 8 || hour > (rules.last_start != null ? rules.last_start : 15.5)) return false;
  if (rules.no_wednesday && dayIndex === 2) return false;
  if (dayIndex === 0 && rules.monday_from != null && hour < rules.monday_from) return false;
  return true;
}

function proposeFromWindows(windows, input) {
  var rules = (input.resource && input.resource.desk_rules) || {};
  var busy = busyInstants(input.events, input.pending_offers);
  var weekStart = mondayIso(input.week_start || '2026-09-14');
  var found = null;
  (windows || []).forEach(function (w) {
    if (found) return;
    var startMs = w.start_instant != null ? w.start_instant : toInstant(w.start_iso);
    var endMs = w.end_instant != null ? w.end_instant : toInstant(w.end_iso);
    if (startMs == null || endMs == null) return;
    var cursor = startMs;
    while (cursor + 60 * 60 * 1000 <= endMs + 1) {
      var local = perthParts(cursor);
      if (!legalStart(local.hour, rules, local.date, weekStart)) {
        cursor += 15 * 60 * 1000;
        continue;
      }
      var slotEnd = cursor + 60 * 60 * 1000;
      var clash = busy.some(function (b) {
        if (b.malformed) return true;
        return rangeOverlap(cursor, slotEnd, b.start, b.end);
      });
      var customerDate = !!(w.explicit_date || w.customer_date_specified);
      var cand = {
        start_iso: isoPerth(local.date, local.hour).local,
        end_iso: perthParts(slotEnd).date === local.date
          ? isoPerth(local.date, local.hour + 1).local
          : isoPerth(perthParts(slotEnd).date, perthParts(slotEnd).hour).local,
        start_instant: cursor,
        end_instant: slotEnd,
        date_source: w.date_source || (customerDate ? 'customer' : 'ai_proposed'),
        customer_date_specified: customerDate,
        window_label: customerDate
          ? (w.source_message_id ? 'inbound ' + w.source_message_id : 'inbound window')
          : 'AI-proposed date, customer date unspecified'
      };
      if (!clash && slotFeasible(cand, input)) {
        found = cand;
        return;
      }
      cursor += 15 * 60 * 1000;
    }
  });
  return found;
}

function lastInbound(input) {
  var inbound = sortMessages(input.messages).filter(function (m) {
    return (m.direction || 'inbound') !== 'outbound';
  });
  return inbound.length ? inbound[inbound.length - 1] : null;
}

function leaveClash(startMs, endMs, input) {
  return (input.leave_intervals || []).some(function (iv) {
    var s = toInstant(iv.start_iso || iv.start);
    var e = toInstant(iv.end_iso || iv.end);
    if (s == null || e == null) return true;
    return rangeOverlap(startMs, endMs, s, e);
  });
}

function travelMinutesBetween(input, fromSuburb, toSuburb) {
  if (!fromSuburb || !toSuburb) return null;
  if (fromSuburb === toSuburb) return 0;
  var legs = input.route_legs || [];
  var i;
  for (i = 0; i < legs.length; i++) {
    if (legs[i].from === fromSuburb && legs[i].to === toSuburb && typeof legs[i].minutes === 'number') {
      return legs[i].minutes;
    }
  }
  if (typeof input.travel_minutes === 'number') return input.travel_minutes;
  return null;
}

function occupancyVisits(input) {
  var out = [];
  (input.events || []).concat(input.pending_offers || []).forEach(function (ev) {
    var s = toInstant(ev.start_iso || ev.start);
    var e = toInstant(ev.end_iso || ev.end);
    if (s == null || e == null) return;
    out.push({ start: s, end: e, suburb: ev.suburb || ev.location || null });
  });
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

function resolveTravelMinutes(input, fromSuburb, toSuburb) {
  var mins = travelMinutesBetween(input, fromSuburb, toSuburb);
  if (mins != null) return mins;
  if (typeof input.travel_minutes === 'number') return input.travel_minutes;
  if (fromSuburb && toSuburb && fromSuburb !== toSuburb) return null;
  return 0;
}

function travelClash(startMs, endMs, input) {
  var site = input.suburb;
  var prev = input.previous_visit
    ? { end: toInstant(input.previous_visit.end_iso), suburb: input.previous_visit.suburb }
    : null;
  var next = input.next_visit
    ? { start: toInstant(input.next_visit.start_iso), suburb: input.next_visit.suburb }
    : null;
  occupancyVisits(input).forEach(function (v) {
    if (v.end <= startMs && (!prev || prev.end == null || v.end >= prev.end)) prev = { end: v.end, suburb: v.suburb };
    if (v.start >= endMs && (!next || next.start == null || v.start < next.start)) next = { start: v.start, suburb: v.suburb };
  });
  if (prev) {
    if (prev.end == null) return true;
    var afterPrior = resolveTravelMinutes(input, prev.suburb, site);
    if (afterPrior == null) return true;
    if (prev.end <= startMs && startMs < prev.end + afterPrior * 60 * 1000) return true;
  }
  if (next) {
    if (next.start == null) return true;
    var toNext = resolveTravelMinutes(input, site, next.suburb);
    if (toNext == null) return true;
    if (startMs < next.start && endMs + toNext * 60 * 1000 > next.start) return true;
  }
  return false;
}

function slotFeasible(slot, input) {
  if (!slot || slot.start_instant == null || slot.end_instant == null) return false;
  var nowMs = toInstant(input.now || input.as_of);
  if (nowMs != null && slot.start_instant < nowMs) return false;
  if (leaveClash(slot.start_instant, slot.end_instant, input)) return false;
  if (travelClash(slot.start_instant, slot.end_instant, input)) return false;
  return true;
}

export function validate(ground, model, input) {
  input = input || {};
  ground = ground || conservativeExtract(input);
  var reasons = (ground.review_reasons || []).slice();
  var status = 'needs_decision';
  var exact = false;
  var proposal = null;
  var messages = sortMessages(input.messages);
  var inbound = lastInbound(input);
  var replyKind = ground.reply_kind || 'unknown';
  var facts = ground.customer_facts || { date_specified: false };
  var windows = (ground.windows || []).slice();
  var usedModelWindows = false;

  if (model && Array.isArray(model.customer_windows)) {
    var adoptedCustomer = [];
    var year = yearFrom(input);
    model.customer_windows.forEach(function (w) {
      var cited = messageById(messages, w.source_message_id);
      if (!cited || (cited.direction || 'inbound') === 'outbound') {
        reasons.push('Model window cited a missing or outbound message.');
        return;
      }
      var startI = toInstant(w.start_iso);
      var endI = toInstant(w.end_iso);
      if (startI == null || endI == null || endI <= startI) {
        reasons.push('Model window times are not valid instants.');
        return;
      }
      if (facts.explicit_date && localWindowPoint(w.start_iso).date !== facts.explicit_date) {
        reasons.push('Model window conflicts with an explicit customer date.');
        return;
      }
      if (laterInboundContradicts(messages, cited, w, year)) {
        reasons.push('Model window is contradicted by a later inbound message.');
        return;
      }
      var grounded = groundWindowAgainstText(w, bodyOf(cited), year);
      if (!grounded.ok) {
        reasons.push(grounded.unverifiable
          ? 'Model window is not independently grounded in the cited inbound text.'
          : 'Model window contradicts the cited inbound text.');
        return;
      }
      if (!grounded.customer_date_specified) {
        reasons.push('Model suggested a slot that is not a customer-declared date.');
        return;
      }
      adoptedCustomer.push({
        start_iso: w.start_iso,
        end_iso: w.end_iso,
        start_instant: startI,
        end_instant: endI,
        source_message_id: w.source_message_id,
        explicit_date: true,
        date_source: 'customer',
        customer_date_specified: true
      });
    });
    if (adoptedCustomer.length) {
      windows = windows.length ? windows.concat(adoptedCustomer) : adoptedCustomer;
      facts.date_specified = true;
      usedModelWindows = true;
    }
  }

  if (model && model.exact_acceptance) {
    var checked = verifyCitedOffer(input, model.accepted_offer, inbound, messages);
    if (!checked.ok) {
      reasons.push('Model acceptance is not bound to a real sent offer (' + checked.reason + ').');
    }
  }
  if (model && model.reply_kind === 'cancellation' && !(inbound && isExplicitCancel(bodyOf(inbound)))) {
    reasons.push('Model cancellation contradicts inbound text.');
    if (replyKind === 'cancellation') replyKind = 'ordinary';
  }
  if (model && model.customer_facts) {
    reasons.push('Model customer_facts are untrusted and were ignored.');
  }

  var bound = inbound && isUnqualifiedYes(bodyOf(inbound)) ? precedingSentOffer(inbound, input, messages) : null;
  if (replyKind === 'acceptance') {
    if (!bound) {
      exact = false;
      replyKind = 'ordinary';
      reasons.push('Acceptance is not bound to a preceding sent offer id and slot revision.');
    } else {
      exact = true;
      ground.accepted_offer = {
        offer_id: bound.offer_id,
        slot_revision: bound.slot_revision,
        start_iso: bound.start_iso,
        end_iso: bound.end_iso,
        message_id: inbound.id || null
      };
    }
  }

  var tags = (input.tags || []).map(function (t) { return String(t).toLowerCase(); });
  var wrongLane = input.resource && input.resource.lane === 'patio' && tags.some(function (t) {
    return t.indexOf('fencing') >= 0 && t.indexOf('patio') < 0;
  });
  if (wrongLane) {
    reasons.push('Lane is unresolved. Do not send Patio-branded outreach.');
    replyKind = 'ordinary';
  }
  if (input.quoted) reasons.push('Already quoted. Confirm whether this is a new request.');

  var lastText = inbound ? bodyOf(inbound) : '';
  var inboundRejectsAvailability = inbound && (
    isBareNo(lastText) ||
    isUnavailability(lastText)
  );
  if (inboundRejectsAvailability) windows = [];

  if (replyKind === 'cancellation' && !wrongLane && inbound && isExplicitCancel(bodyOf(inbound))) {
    status = 'repair';
  } else if (exact && !wrongLane) {
    status = 'needs_decision';
  } else if (inboundRejectsAvailability) {
    status = 'needs_decision';
    proposal = null;
    reasons.push('Latest inbound is not availability. Do not invent a customer date or Ready offer.');
  } else {
    var slot = null;
    if (windows && windows.length) {
      slot = proposeFromWindows(windows, input);
      if (slot && slot.customer_date_specified !== true && slot.date_source !== 'customer') {
        slot.date_source = slot.date_source || 'ai_proposed';
        slot.customer_date_specified = false;
      }
    } else if (!wrongLane) {
      slot = proposeCandidate(input, facts);
    }
    var capGaps = occupancyGaps(input);
    if (capGaps.length) {
      reasons.push('Calendar, leave or travel coverage is missing. Not execution-ready. ' + capGaps.join(','));
      status = 'needs_decision';
      proposal = null;
    } else if (!slot) {
      reasons.push('No feasible slot under current rules and occupancy.');
      status = 'needs_decision';
      proposal = null;
    } else if (wrongLane) {
      status = 'needs_decision';
      proposal = null;
    } else {
      status = 'ready';
      proposal = slot;
      if (slot.date_source === 'ai_proposed') {
        reasons.push('AI-proposed date, customer date unspecified.');
      }
    }
  }

  if (input.send_evidence && input.send_evidence !== 'sent' && status === 'waiting') {
    status = 'needs_decision';
    reasons.push('Send is not evidenced. Cannot sit in Waiting for reply.');
  }

  var draft = '';
  if (proposal && status === 'ready') {
    var hm = String(proposal.start_iso).slice(11, 16);
    var hour = Number(hm.slice(0, 2));
    var min = hm.slice(3);
    var ampm = hour >= 12 ? 'pm' : 'am';
    var h12 = hour % 12 || 12;
    var who = (input.resource && input.resource.name) || 'SecureWorks';
    var lane = input.resource && input.resource.lane === 'fencing' ? 'SecureWorks Fencing' : 'SecureWorks Patios';
    var when = String(proposal.start_iso).slice(0, 10) + ' at ' + h12 + ':' + min + ampm;
    if (proposal.date_source === 'ai_proposed') {
      draft = 'Hi, I can visit ' + when + ' in ' + (input.suburb || 'the site') + '. Does that suit? ' + who + ', ' + lane;
    } else {
      draft = 'Hi, ' + when + ' in ' + (input.suburb || 'the site') + ' works for me. Can someone be there then? ' + who + ', ' + lane;
    }
    proposal.draft = draft;
    proposal.kind = 'proposal';
  }

  return {
    version: VERSION,
    interpreter: usedModelWindows ? 'ops-ai-structured-validated' : (ground.interpreter || INTERPRETER_FALLBACK),
    intelligent_automation: !!usedModelWindows,
    week_start: mondayIso(input.week_start || '2026-09-14'),
    reply_kind: replyKind,
    exact_acceptance: exact,
    accepted_offer: exact ? ground.accepted_offer : null,
    status: status,
    reason: reasons[0] || (status === 'ready' ? 'Candidate slot for approval. This is not exact acceptance.' : 'Needs a human decision.'),
    review_reasons: reasons,
    customer_facts: facts,
    windows: windows,
    proposal: proposal,
    draft: draft,
    evidence: {
      source_message_ids: (inbound && inbound.id ? [inbound.id] : []).concat(
        (input.sent_offers || []).map(function (o) { return o.message_id; }).filter(Boolean)
      ),
      accepted_offer_id: exact && ground.accepted_offer ? ground.accepted_offer.offer_id : null,
      slot_revision: exact && ground.accepted_offer ? ground.accepted_offer.slot_revision : null,
      coverage: input.coverage || null,
      rule_version: input.rule_version || 'desk-rules-inline',
      wrong_lane: !!wrongLane,
      quoted: !!input.quoted
    }
  };
}



export function assess(input) {
  input = input || {};
  var ground = conservativeExtract(input);
  var model = typeof input.reason === 'function' ? input.reason(input) : null;
  return validate(ground, model, input);
}

export function reasonPrompt(input) {
  return {
    task: 'sales_booking_conversation_assessment',
    schema_version: VERSION,
    timezone: TZ_PERTH,
    instructions: [
      'Return JSON only.',
      'Separate customer facts from candidate scheduling.',
      'Customer constraints may come from inbound messages only.',
      'A cited inbound id is not proof of the window content. The cited text must independently support the date and time.',
      'If the customer gives a time-of-day with no date, record that preference and you may suggest a verified-free slot labelled AI-proposed date, customer date unspecified.',
      'Do not write an AI-suggested day as a customer-declared window or exact acceptance.',
      'If a later inbound contradicts an earlier window, drop the earlier window.',
      'If the interpretation is not verifiable from the cited text, return review_reasons and do not invent a customer date.',
      'Initial outreach may propose a suitable slot pending approval without pretending the customer supplied availability.',
      'Exact acceptance requires the preceding sent offer id and slot revision.',
      'Do not map an explicit calendar date onto a different week.',
      'Ambiguous or negated language is never cancellation or exact acceptance.'
    ],
    input: {
      week_start: input.week_start,
      messages: sortMessages(input.messages).map(function (m) {
        return { id: m.id || null, direction: m.direction, timestamp: m.timestamp, body: bodyOf(m) };
      }),
      sent_offers: input.sent_offers || [],
      coverage: input.coverage || null,
      resource: input.resource ? { name: input.resource.name, lane: input.resource.lane } : null
    }
  };
}

export async function assessWithReason(input) {
  input = input || {};
  var adapter = input.reasonAsync || (typeof globalThis !== 'undefined' && globalThis.SALES_BOOKING_REASON);
  if (typeof adapter !== 'function') return assess(input);
  var ground = conservativeExtract(input);
  var raw = await adapter(reasonPrompt(input));
  return validate(ground, raw, input);
}

export function applyReplyToStatus(currentStatus, replyKind, bound) {
  if (replyKind === 'acceptance' && bound) return { status: 'needs_decision', exact_acceptance: true, action: 'confirm_booking' };
  if (replyKind === 'acceptance' && !bound) return { status: 'needs_decision', exact_acceptance: false, action: 'approve_offer' };
  if (replyKind === 'new_availability' || replyKind === 'decline') return { status: 'ready', exact_acceptance: false, action: 'approve_offer' };
  if (replyKind === 'cancellation') return { status: 'repair', exact_acceptance: false, action: 'repair' };
  if (currentStatus === 'waiting' || currentStatus === 'follow_up' || currentStatus === 'offer') {
    return { status: 'needs_decision', exact_acceptance: false, action: 'approve_offer' };
  }
  return { status: currentStatus || 'needs_decision', exact_acceptance: false, action: 'approve_offer' };
}

