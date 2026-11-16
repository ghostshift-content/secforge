class Expense < ApplicationRecord
  belongs_to :user
  belongs_to :team

  has_one :receipt, dependent: :destroy
  has_many :approvals, dependent: :destroy
  has_one :reimbursement, dependent: :destroy

  enum status: { pending: 0, approved: 1, rejected: 2, reimbursed: 3 }

  validates :description, presence: true
  validates :amount_cents, numericality: { greater_than: 0 }
  validates :incurred_on, presence: true

  before_validation :set_team_from_user, on: :create

  def approve!(_approver)
    return false if approved? || reimbursed?

    update!(status: :approved)
    Reimbursement.create!(expense: self, amount_cents: amount_cents, status: :pending)
    true
  end

  def reassign_to_team!(new_team)
    update!(team: new_team)
  end

  private

  def set_team_from_user
    self.team_id ||= user&.team_id
  end
end
