class Approval < ApplicationRecord
  belongs_to :expense
  belongs_to :approver, class_name: "User", inverse_of: :approvals

  enum status: { pending: 0, approved: 1, rejected: 2 }

  validates :status, presence: true
end
