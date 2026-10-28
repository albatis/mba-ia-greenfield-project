import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import { SignedPartsResponseDto } from './dto/signed-parts-response.dto';
import { UploadPartsResponseDto } from './dto/upload-parts-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Creates the draft video and the multipart upload in storage, and returns the server-dictated part plan. Part URLs are signed on demand.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'FILE_TOO_LARGE, UNSUPPORTED_VIDEO_TYPE or VALIDATION_ERROR',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':videoId/upload/parts')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Signs presigned PUT URLs for the requested parts. Also used to re-sign missing parts when resuming an upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: SignedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'INVALID_PART_NUMBER or VALIDATION_ERROR',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_NOT_IN_PROGRESS',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: SignPartsDto,
  ): Promise<SignedPartsResponseDto> {
    return this.videosService.signUploadParts(user.sub, videoId, dto);
  }

  @Get(':videoId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts storage already holds, so a resumed upload re-sends only the missing ones.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload plan and parts already in storage',
    type: UploadPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_NOT_IN_PROGRESS',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<UploadPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, videoId);
  }
}
