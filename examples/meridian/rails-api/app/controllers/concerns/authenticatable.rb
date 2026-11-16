module Authenticatable
  extend ActiveSupport::Concern

  included do
    include Pundit::Authorization

    before_action :authenticate_user!

    rescue_from Pundit::NotAuthorizedError, with: :render_forbidden
    rescue_from ActiveRecord::RecordNotFound, with: :render_not_found
  end

  private

  def render_forbidden
    render json: { error: "You are not authorized to perform this action" }, status: :forbidden
  end

  def render_not_found
    render json: { error: "Resource not found" }, status: :not_found
  end
end
