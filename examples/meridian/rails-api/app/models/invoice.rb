class Invoice < ApplicationRecord
  belongs_to :organization

  enum status: { draft: 0, sent: 1, paid: 2, overdue: 3 }

  validates :invoice_number, presence: true, uniqueness: { scope: :organization_id }
  validates :amount_cents, numericality: { greater_than: 0 }
  validates :due_date, presence: true
end
