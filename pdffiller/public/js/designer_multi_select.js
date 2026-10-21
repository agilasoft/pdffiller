/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

(function (root) {
	"use strict";

	const GROUP_RE = /^grp_[A-Za-z0-9]+$/;

	function bounds(obj) {
		const x = Number(obj.x) || 0;
		const y = Number(obj.y) || 0;
		const width = Number(obj.width) || 0;
		const height = Number(obj.height) || 0;
		return {
			x: Math.min(x, x + width),
			y: Math.min(y, y + height),
			width: Math.max(Math.abs(width), 0),
			height: Math.max(Math.abs(height), 0),
		};
	}

	function intersects(a, b) {
		if (!a || !b) return false;
		return (
			a.x < b.x + b.width &&
			a.x + a.width > b.x &&
			a.y < b.y + b.height &&
			a.y + a.height > b.y
		);
	}

	function union(objects) {
		const boxes = (objects || []).map(bounds).filter((box) => box.width || box.height);
		if (!boxes.length) return null;
		const left = Math.min(...boxes.map((box) => box.x));
		const top = Math.min(...boxes.map((box) => box.y));
		const right = Math.max(...boxes.map((box) => box.x + box.width));
		const bottom = Math.max(...boxes.map((box) => box.y + box.height));
		return { x: left, y: top, width: right - left, height: bottom - top };
	}

	function unique(ids) {
		const seen = new Set();
		const result = [];
		(ids || []).forEach((id) => {
			if (!id || seen.has(id)) return;
			seen.add(id);
			result.push(id);
		});
		return result;
	}

	function clampToPage(starts, dx, dy, pageW, pageH) {
		let minDx = -Infinity;
		let maxDx = Infinity;
		let minDy = -Infinity;
		let maxDy = Infinity;
		(starts || []).forEach((obj) => {
			const box = bounds(obj);
			minDx = Math.max(minDx, -box.x);
			maxDx = Math.min(maxDx, pageW - (box.x + box.width));
			minDy = Math.max(minDy, -box.y);
			maxDy = Math.min(maxDy, pageH - (box.y + box.height));
		});
		if (minDx > maxDx) {
			minDx = 0;
			maxDx = 0;
		}
		if (minDy > maxDy) {
			minDy = 0;
			maxDy = 0;
		}
		return {
			dx: Math.min(maxDx, Math.max(minDx, dx)),
			dy: Math.min(maxDy, Math.max(minDy, dy)),
		};
	}

	function movedBounds(starts, dx, dy) {
		return (starts || []).map((obj) => {
			const box = bounds(obj);
			return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
		});
	}

	function hits(moved, blockers) {
		return moved.some((box) => blockers.some((other) => intersects(box, bounds(other))));
	}

	function fitDelta(starts, dx, dy, pageW, pageH, others) {
		const clamped = clampToPage(starts, dx || 0, dy || 0, pageW, pageH);
		const blockers = (others || []).filter((other) => {
			const otherBox = bounds(other);
			return !(starts || []).some((start) => intersects(bounds(start), otherBox));
		});
		if (!hits(movedBounds(starts, clamped.dx, clamped.dy), blockers)) return clamped;
		let low = 0;
		let high = 1;
		for (let step = 0; step < 14; step += 1) {
			const mid = (low + high) / 2;
			if (hits(movedBounds(starts, clamped.dx * mid, clamped.dy * mid), blockers)) high = mid;
			else low = mid;
		}
		return { dx: clamped.dx * low, dy: clamped.dy * low };
	}

	function applySelection(options) {
		const ids = unique(options.ids);
		const targetId = options.targetId;
		const group = unique(
			typeof options.groupOf === "function" ? options.groupOf(targetId) : [targetId]
		);
		if (!group.length) return { ids, anchorId: options.anchorId || null };

		if (options.toggle) {
			const selected = group.every((id) => ids.includes(id));
			const next = selected ? ids.filter((id) => !group.includes(id)) : ids.concat(group);
			return { ids: unique(next), anchorId: targetId };
		}

		if (options.extend && options.range && options.orderedIds && options.anchorId) {
			const ordered = options.orderedIds;
			const start = ordered.indexOf(options.anchorId);
			const end = ordered.indexOf(targetId);
			if (start >= 0 && end >= 0) {
				const from = Math.min(start, end);
				const to = Math.max(start, end);
				const rangeIds = ordered.slice(from, to + 1).flatMap((id) =>
					typeof options.groupOf === "function" ? options.groupOf(id) : [id]
				);
				return { ids: unique(ids.concat(rangeIds)), anchorId: options.anchorId };
			}
		}

		if (options.extend) return { ids: unique(ids.concat(group)), anchorId: targetId };
		if (options.keepIfSelected && ids.includes(targetId)) {
			return { ids, anchorId: targetId };
		}
		return { ids: group, anchorId: targetId };
	}

	function newGroupId() {
		const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
		return `grp_${token.replace(/[^A-Za-z0-9]/g, "")}`;
	}

	function cleanGroupId(value) {
		const groupId = String(value || "").trim();
		return GROUP_RE.test(groupId) ? groupId : "";
	}

	const CLIP_KEY = "pdffiller.designer.clipboard";
	let memoryClipboard = null;
	let contextMenu = null;
	let contextCleanup = null;

	function clipStorage() {
		try {
			if (typeof sessionStorage !== "undefined") return sessionStorage;
		} catch (err) {
			return null;
		}
		return null;
	}

	function writeClipboard(payload) {
		const data = {
			version: 1,
			copiedAt: Date.now(),
			source: payload.source || {},
			objects: JSON.parse(JSON.stringify(payload.objects || [])),
		};
		memoryClipboard = data;
		try {
			clipStorage()?.setItem(CLIP_KEY, JSON.stringify(data));
		} catch (err) {
			// The in-memory copy still works for this desk session.
		}
		return data;
	}

	function readClipboard() {
		if (memoryClipboard && memoryClipboard.objects) return memoryClipboard;
		try {
			const raw = clipStorage()?.getItem(CLIP_KEY);
			memoryClipboard = raw ? JSON.parse(raw) : null;
		} catch (err) {
			memoryClipboard = null;
		}
		return memoryClipboard && memoryClipboard.objects ? memoryClipboard : null;
	}

	function hasClipboard() {
		const clip = readClipboard();
		return Boolean(clip && clip.objects && clip.objects.length);
	}

	function uniqueFieldName(name, existing) {
		let base = String(name || "field").replace(/[^A-Za-z0-9_]/g, "_");
		base = base.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
		if (!/^[A-Za-z]/.test(base)) base = `field_${base || "copy"}`;
		base = base.slice(0, 40);
		const names = existing instanceof Set ? existing : new Set(existing || []);
		if (!names.has(base)) {
			names.add(base);
			return base;
		}
		let index = 2;
		let candidate = `${base}_${index}`.slice(0, 48);
		while (names.has(candidate)) {
			index += 1;
			candidate = `${base}_${index}`.slice(0, 48);
		}
		names.add(candidate);
		return candidate;
	}

	function referenceSets(referenceFields, childTables) {
		const fields = new Set((referenceFields || []).map((field) => field.fieldname).filter(Boolean));
		const tables = new Map();
		(childTables || []).forEach((table) => {
			if (!table || !table.fieldname) return;
			tables.set(
				table.fieldname,
				new Set((table.fields || []).map((field) => field.fieldname).filter(Boolean))
			);
		});
		return { fields, tables };
	}

	function clearInvalidMapping(obj, refs) {
		const cleared = [];
		const sourceType = obj.source_type || "Field Path";
		if (obj.repeat_table) {
			const childFields = refs.tables.get(obj.repeat_table);
			if (!childFields) {
				obj.repeat_table = "";
				obj.repeat_field = "";
				obj.repeat_slot = 0;
				if (sourceType !== "Jinja Script") obj.source_field = "";
				cleared.push("child table");
			} else if ((obj.repeat_field || obj.source_field) && !childFields.has(obj.repeat_field || obj.source_field)) {
				obj.repeat_field = "";
				if (sourceType !== "Jinja Script") obj.source_field = "";
				cleared.push("child field");
			}
		} else if (sourceType !== "Jinja Script" && obj.source_field && !refs.fields.has(obj.source_field)) {
			obj.source_field = "";
			cleared.push("field");
		}
		return cleared;
	}

	function insidePage(box, pageW, pageH) {
		return box.x >= -0.01 && box.y >= -0.01 && box.x + box.width <= pageW + 0.01 && box.y + box.height <= pageH + 0.01;
	}

	function groupFits(objects, dx, dy, pageW, pageH, obstacles) {
		const moved = movedBounds(objects, dx, dy);
		if (moved.some((box) => !insidePage(box, pageW, pageH))) return false;
		return !moved.some((box) => (obstacles || []).some((other) => intersects(box, bounds(other))));
	}

	function findPasteOffset(objects, pageW, pageH, obstacles, prefer) {
		const preferred = prefer || { dx: 0, dy: 0 };
		const candidates = [preferred, { dx: 0, dy: 0 }];
		for (let step = 12; step <= 360; step += 12) {
			candidates.push(
				{ dx: step, dy: step },
				{ dx: step, dy: 0 },
				{ dx: 0, dy: step },
				{ dx: -step, dy: 0 },
				{ dx: 0, dy: -step },
				{ dx: -step, dy: step },
				{ dx: step, dy: -step }
			);
		}
		for (let i = 0; i < candidates.length; i += 1) {
			const candidate = candidates[i];
			if (groupFits(objects, candidate.dx, candidate.dy, pageW, pageH, obstacles)) return candidate;
		}
		return clampToPage(objects, preferred.dx, preferred.dy, pageW, pageH);
	}

	function preparePaste(clip, options) {
		const editor = options.editor;
		const incoming = JSON.parse(JSON.stringify((clip && clip.objects) || []));
		const objects = [];
		let skipped = 0;
		incoming.forEach((obj) => {
			const kind = obj.kind || "field";
			if (editor === "field" && kind !== "field") {
				skipped += 1;
				return;
			}
			obj.kind = kind;
			objects.push(obj);
		});

		const groupMap = {};
		objects.forEach((obj) => {
			const groupId = cleanGroupId(obj.group_id);
			if (!groupId) {
				obj.group_id = "";
				return;
			}
			if (!groupMap[groupId]) groupMap[groupId] = newGroupId();
			obj.group_id = groupMap[groupId];
		});

		const names = new Set(options.existingNames || []);
		const refs = referenceSets(options.referenceFields, options.childTables);
		const cleared = [];
		objects.forEach((obj) => {
			if ((obj.kind || "field") !== "field") return;
			obj.field_name = uniqueFieldName(obj.field_name, names);
			const issues = clearInvalidMapping(obj, refs);
			if (issues.length) cleared.push(obj.field_name);
		});

		const source = (clip && clip.source) || {};
		const sameSpot = Boolean(options.sameDocument && options.samePage);
		const offset = findPasteOffset(
			objects,
			options.pageWidth,
			options.pageHeight,
			options.obstacles || [],
			sameSpot ? { dx: 12, dy: 12 } : { dx: 0, dy: 0 }
		);
		objects.forEach((obj) => {
			obj.x = (Number(obj.x) || 0) + offset.dx;
			obj.y = (Number(obj.y) || 0) + offset.dy;
			if (editor === "field") obj.page = options.pageIndex || 0;
		});

		return { objects, skipped, cleared, offset };
	}

	function closeContextMenu() {
		if (contextCleanup) contextCleanup();
		contextCleanup = null;
		if (contextMenu) contextMenu.remove();
		contextMenu = null;
	}

	function openContextMenu(x, y, items) {
		closeContextMenu();
		const menu = document.createElement("div");
		menu.className = "pfd-context-menu";
		menu.setAttribute("role", "menu");
		menu.innerHTML = (items || [])
			.map(
				(item) =>
					`<button type="button" role="menuitem" data-action="${item.action}" ${
						item.disabled ? "disabled" : ""
					}><span>${item.label}</span>${item.shortcut ? `<kbd>${item.shortcut}</kbd>` : ""}</button>`
			)
			.join("");
		document.body.appendChild(menu);
		const rect = menu.getBoundingClientRect();
		const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
		const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
		menu.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`;
		menu.style.top = `${Math.min(Math.max(8, y), maxTop)}px`;
		contextMenu = menu;

		function onPointer(event) {
			if (menu.contains(event.target)) return;
			closeContextMenu();
		}
		function onKey(event) {
			if (event.key === "Escape") closeContextMenu();
		}
		document.addEventListener("mousedown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		contextCleanup = () => {
			document.removeEventListener("mousedown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
		menu.addEventListener("click", (event) => {
			const button = event.target.closest("button");
			if (!button || button.disabled) return;
			const action = button.dataset.action;
			const item = (items || []).find((entry) => entry.action === action);
			closeContextMenu();
			if (item && typeof item.onSelect === "function") item.onSelect();
		});
		return menu;
	}

	root.pdffiller = root.pdffiller || {};
	root.pdffiller.multi_select = {
		GROUP_RE,
		bounds,
		intersects,
		union,
		unique,
		fitDelta,
		applySelection,
		newGroupId,
		cleanGroupId,
		writeClipboard,
		readClipboard,
		hasClipboard,
		uniqueFieldName,
		preparePaste,
		openContextMenu,
		closeContextMenu,
	};
})(typeof window !== "undefined" ? window : globalThis);
