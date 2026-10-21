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
	};
})(typeof window !== "undefined" ? window : globalThis);
