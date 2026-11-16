class UsersController < ApplicationController
  before_action :set_user, only: [:show, :update]

  def index
    render json: current_user.organization.users
  end

  def show
    render json: @user
  end

  def update
    ensure_self_or_admin!

    if @user.update(user_params)
      render json: @user
    else
      render json: { errors: @user.errors.full_messages }, status: :unprocessable_entity
    end
  end

  private

  def set_user
    @user = current_user.organization.users.find(params[:id])
  end

  def ensure_self_or_admin!
    return if @user.id == current_user.id || current_user.admin?

    render json: { error: "You are not authorized to perform this action" }, status: :forbidden
  end

  def user_params
    params.require(:user).permit(
      :name,
      :avatar_url,
      :phone,
      :role_id
    )
  end
end
