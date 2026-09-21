// Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
// For license information, please see license.txt

frappe.ui.form.on("PDF Print Design", {
	refresh(frm) {
		if (!frm.is_new()) {
			frm.add_custom_button(__("Design Page"), function () {
				frappe.set_route("pdf-print-designer", frm.doc.name);
			});
		}
	},
	paper_size(frm) {
		const sizes = {
			A4: { width: 595, height: 842 },
			Letter: { width: 612, height: 792 },
			Legal: { width: 612, height: 1008 },
		};
		const size = sizes[frm.doc.paper_size];
		if (!size) return;
		frm.set_value("page_width", size.width);
		frm.set_value("page_height", size.height);
	},
});
