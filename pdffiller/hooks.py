app_name = "pdffiller"
app_title = "PDF Filler"
app_publisher = "Agilasoft Cloud Technologies Inc."
app_description = "Fillable PDF forms linked to DocTypes"
app_email = "info@agilasoft.com"
app_license = "agpl-3.0"

app_include_js = [
	"/assets/pdffiller/js/pdf_viewer_dialog.js",
	"/assets/pdffiller/js/pdf_form_buttons.js",
]
app_include_css = ["/assets/pdffiller/css/pdf_viewer_dialog.css"]

fixtures = [{"dt": "Workspace", "filters": [["module", "=", "PDF Filler"]]}]

doctype_js = {"PDF Form Template": "public/js/pdf_form_template.js"}
