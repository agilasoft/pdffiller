// Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
// For license information, please see license.txt

function removeWorkdeskPanel(frm) {
	const page = frm.page && frm.page.wrapper;
	if (!page) return;
	page.find(".wd-layout").remove();
	page.find(".wd-layout-toggle").remove();
	page.find(".layout-main").removeClass("wd-layout-active");
	page.find(".layout-side-section").removeClass("wd-native-side-hidden");
}

frappe.ui.form.on("PDF Print Design", {
	refresh(frm) {
		removeWorkdeskPanel(frm);
		setTimeout(() => removeWorkdeskPanel(frm), 0);
		frm.add_custom_button(__("Import"), function () {
			pdffiller.transfer.import_templates(function (summary) {
				const title = frm.doc.title;
				const touched =
					summary &&
					(summary.results || []).some(
						(row) =>
							row.title === title &&
							(row.status === "created" || row.status === "updated")
					);
				if (touched && !frm.is_new()) {
					frm.reload_doc();
				}
			});
		});

		if (!frm.is_new()) {
			frm.add_custom_button(__("Design Page"), function () {
				frappe.set_route("pdf-print-designer", frm.doc.name);
			});
			frm.add_custom_button(__("Export"), function () {
				pdffiller.transfer.export_print_designs([frm.doc.name]);
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
