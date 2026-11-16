class Reimbursement < ApplicationRecord
  belongs_to :expense

  enum status: { pending: 0, paid: 1, failed: 2 }

  validates :amount_cents, numericality: { greater_than: 0 }
end
