class Team < ApplicationRecord
  belongs_to :organization

  has_many :users, dependent: :nullify
  has_many :expenses, dependent: :nullify

  validates :name, presence: true
  validates :name, uniqueness: { scope: :organization_id }
end
