/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.workdesk");

(function () {
	"use strict";

	function clearHighlight() {
		document.querySelectorAll(".wd-highlight").forEach((el) => el.classList.remove("wd-highlight"));
		const badge = document.querySelector(".wd-highlight-badge");
		if (badge) badge.hidden = true;
	}

	function clearWorkdesk(frm) {
		clearHighlight();
		if (!frm || !frm.page || !frm.page.wrapper) return;
		const page = frm.page.wrapper;
		const main = page.find(".layout-main");
		main.removeClass("wd-layout-active");
		main.children(".layout-side-section").removeClass("wd-native-side-hidden");
		main.find(".wd-layout").remove();
		page.find(".wd-layout-toggle").remove();
		if (typeof frm.page.remove_inner_button === "function") {
			frm.page.remove_inner_button(__("Layout"));
		}
	}

	pdffiller.workdesk.refresh = function (frm) {
		clearWorkdesk(frm);
	};

	frappe.ui.form.on("*", {
		refresh(frm) {
			pdffiller.workdesk.refresh(frm);
		},
	});
})();
