class User < ApplicationRecord
  devise :database_authenticatable, :registerable,
         :recoverable, :rememberable, :validatable

  belongs_to :organization
  belongs_to :team
  belongs_to :role

  has_many :expenses, dependent: :destroy
  has_many :approvals, foreign_key: :approver_id, inverse_of: :approver, dependent: :nullify
  has_many :reports, foreign_key: :generated_by_id, inverse_of: :generated_by, dependent: :nullify

  validates :name, presence: true
  validate :team_belongs_to_organization

  delegate :admin?, :manager?, :member?, :auditor?, to: :role, allow_nil: true

  private

  def team_belongs_to_organization
    return if team.nil? || organization.nil?

    errors.add(:team, "must belong to the user's organization") if team.organization_id != organization_id
  end
end
