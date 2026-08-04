// Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
// For license information, please see license.txt

frappe.listview_settings["PDF Form Template"] = {
	onload(listview) {
		listview.page.add_inner_button(__("Export All"), () => {
			pdffiller.transfer.export_templates();
		});

		listview.page.add_inner_button(__("Export Selected"), () => {
			const names = listview.get_checked_items(true);
			if (!names.length) {
				frappe.msgprint({
					title: __("No Selection"),
					message: __("Select one or more templates to export."),
					indicator: "orange",
				});
				return;
			}
			pdffiller.transfer.export_templates(names);
		});

		listview.page.add_inner_button(__("Import"), () => {
			pdffiller.transfer.import_templates(() => {
				listview.refresh();
			});
		});
	},
};
