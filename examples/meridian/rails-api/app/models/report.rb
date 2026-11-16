class Report < ApplicationRecord
  belongs_to :organization
  belongs_to :generated_by, class_name: "User", inverse_of: :reports

  enum report_type: { expense_summary: 0, tax: 1, audit: 2 }

  validates :period_start, presence: true
  validates :period_end, presence: true
end
