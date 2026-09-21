frappe.pages["pdf-print-designer"].on_page_load = function (wrapper) {
	frappe.require("/assets/pdffiller/js/pdf_print_designer/designer.js", () => {
		pdffiller.print_designer.setup_page(wrapper);
	});
};

frappe.pages["pdf-print-designer"].on_page_show = function () {
	frappe.require("/assets/pdffiller/js/pdf_print_designer/designer.js", () => {
		pdffiller.print_designer.refresh();
	});
};
