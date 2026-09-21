// Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
// For license information, please see license.txt

frappe.listview_settings["PDF Form Template"] = {
	onload(listview) {
		listview.page.add_inner_button(__("Import"), function () {
			pdffiller.transfer.import_templates(function () {
				listview.refresh();
			});
		});

		listview.page.add_action_item(__("Export"), function () {
			const names = listview.get_checked_items().map((d) => d.name);
			if (!names.length) {
				frappe.msgprint(__("Select at least one template to export."));
				return;
			}
			pdffiller.transfer.export_templates(names);
		});
	},
};
